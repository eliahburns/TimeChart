import { DataPoint, RenderModel } from "../core/renderModel";
import { resolveColorRGBA, ResolvedCoreOptions, TimeChartSeriesOptions, LineType } from '../options';
import { domainSearch } from '../utils';
import { vec2 } from 'gl-matrix';
import { TimeChartPlugin } from '.';
import { LinkedWebGLProgram, throwIfFalsy } from './webGLUtils';
import { DataPointsBuffer } from "../core/dataPointsBuffer";


const BUFFER_TEXTURE_WIDTH = 256;
const BUFFER_TEXTURE_HEIGHT = 2048;
const BUFFER_POINT_CAPACITY = BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT;
const BUFFER_INTERVAL_CAPACITY = BUFFER_POINT_CAPACITY - 2;

/**
 * Manages uniform buffer objects (UBOs) for efficient data transfer to WebGL shaders.
 * Handles transformation matrices and scaling factors for rendering.
 */
class ShaderUniformData {
    // Raw binary buffer to store uniform data
    data: ArrayBuffer;
    // WebGL uniform buffer object reference
    ubo: WebGLBuffer;

    /**
     * Creates a new uniform buffer with specified size
     * @param gl WebGL context
     * @param size Size of the uniform buffer in bytes
     */
    constructor(private gl: WebGL2RenderingContext, size: number) {
        // Create ArrayBuffer to store data on CPU side
        this.data = new ArrayBuffer(size);
        // Create and initialize WebGL buffer
        this.ubo = throwIfFalsy(gl.createBuffer());
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
        gl.bufferData(gl.UNIFORM_BUFFER, this.data, gl.DYNAMIC_DRAW);
    }

    /**
     * Access the model scaling factors (x, y)
     * Located at offset 0 in buffer
     */
    get modelScale() {
        return new Float32Array(this.data, 0, 2);
    }

    /**
     * Access the model translation values (x, y)
     * Located at offset 8 bytes (2 floats * 4 bytes)
     */
    get modelTranslate() {
        return new Float32Array(this.data, 2 * 4, 2);
    }

    /**
     * Access the projection scaling factors (x, y)
     * Located at offset 16 bytes (4 floats * 4 bytes)
     */
    get projectionScale() {
        return new Float32Array(this.data, 4 * 4, 2);
    }

    /**
     * Upload the buffer data to GPU
     * @param index Binding point index for the uniform buffer
     */
    upload(index = 0) {
        // Bind buffer to specified index
        this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, index, this.ubo);
        // Upload current data to GPU
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, this.data);
    }
}

const VS_HEADER = `#version 300 es
layout (std140) uniform proj {
    vec2 modelScale;
    vec2 modelTranslate;
    vec2 projectionScale;
};
uniform highp sampler2D uDataPoints;
uniform int uLineType;
uniform float uStepLocation;

const int TEX_WIDTH = ${BUFFER_TEXTURE_WIDTH};
const int TEX_HEIGHT = ${BUFFER_TEXTURE_HEIGHT};

vec2 dataPoint(int index) {
    int x = index % TEX_WIDTH;
    int y = index / TEX_WIDTH;
    return texelFetch(uDataPoints, ivec2(x, y), 0).xy;
}
`

const LINE_FS_SOURCE = `#version 300 es
precision lowp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
    outColor = uColor;
}`;

class NativeLineProgram extends LinkedWebGLProgram {
    locations;
    static VS_SOURCE = `${VS_HEADER}
uniform float uPointSize;

void main() {
    vec2 pos2d = projectionScale * modelScale * (dataPoint(gl_VertexID) + modelTranslate);
    gl_Position = vec4(pos2d, 0, 1);
    gl_PointSize = uPointSize;
}
`

    constructor(gl: WebGL2RenderingContext, debug: boolean) {
        super(gl, NativeLineProgram.VS_SOURCE, LINE_FS_SOURCE, debug);
        this.link();

        this.locations = {
            uDataPoints: this.getUniformLocation('uDataPoints'),
            uPointSize: this.getUniformLocation('uPointSize'),
            uColor: this.getUniformLocation('uColor'),
        }

        this.use();
        gl.uniform1i(this.locations.uDataPoints, 0);
        const projIdx = gl.getUniformBlockIndex(this.program, 'proj');
        gl.uniformBlockBinding(this.program, projIdx, 0);
    }
}

class LineProgram extends LinkedWebGLProgram {
    static VS_SOURCE = `${VS_HEADER}
uniform float uLineWidth;

void main() {
    int side = gl_VertexID & 1;
    int di = (gl_VertexID >> 1) & 1;
    int index = gl_VertexID >> 2;

    vec2 dp[2] = vec2[2](dataPoint(index), dataPoint(index + 1));

    vec2 base;
    vec2 off;
    if (uLineType == ${LineType.Line}) {
        base = dp[di];
        vec2 dir = dp[1] - dp[0];
        dir = normalize(modelScale * dir);
        off = vec2(-dir.y, dir.x) * uLineWidth;
    } else if (uLineType == ${LineType.Step}) {
        base = vec2(dp[0].x * (1. - uStepLocation) + dp[1].x * uStepLocation, dp[di].y);
        float up = sign(dp[0].y - dp[1].y);
        off = vec2(uLineWidth * up, uLineWidth);
    }

    if (side == 1)
        off = -off;
    vec2 cssPose = modelScale * (base + modelTranslate);
    vec2 pos2d = projectionScale * (cssPose + off);
    gl_Position = vec4(pos2d, 0, 1);
}`;

    locations;
    constructor(gl: WebGL2RenderingContext, debug: boolean) {
        super(gl, LineProgram.VS_SOURCE, LINE_FS_SOURCE, debug);
        this.link();

        this.locations = {
            uDataPoints: this.getUniformLocation('uDataPoints'),
            uLineType: this.getUniformLocation('uLineType'),
            uStepLocation: this.getUniformLocation('uStepLocation'),
            uLineWidth: this.getUniformLocation('uLineWidth'),
            uColor: this.getUniformLocation('uColor'),
        }

        this.use();
        gl.uniform1i(this.locations.uDataPoints, 0);
        const projIdx = gl.getUniformBlockIndex(this.program, 'proj');
        gl.uniformBlockBinding(this.program, projIdx, 0);
    }
}

/**
 * Manages a fixed-size segment of data points in a WebGL texture buffer.
 * Each segment can store BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT points.
 * Points are stored as (x,y) pairs in a 2D texture for efficient GPU access.
 */
class SeriesSegmentVertexArray {
    // WebGL texture buffer to store data points
    dataBuffer: WebGLTexture;

    /**
     * Creates a new segment buffer for storing data points
     * @param gl WebGL context
     * @param dataPoints Source data buffer containing all points
     */
    constructor(
        private gl: WebGL2RenderingContext,
        private dataPoints: DataPointsBuffer,
    ) {
        // Create and initialize texture buffer
        this.dataBuffer = throwIfFalsy(gl.createTexture());
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        
        // Allocate immutable texture storage (RG32F format for x,y float pairs)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, 
            BUFFER_TEXTURE_WIDTH, BUFFER_TEXTURE_HEIGHT);
        
        // Initialize texture with empty data
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 
            BUFFER_TEXTURE_WIDTH, BUFFER_TEXTURE_HEIGHT, 
            gl.RG, gl.FLOAT, 
            new Float32Array(BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT * 2));
        
        // Set texture parameters for point sampling
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }

    /**
     * Clean up WebGL resources
     */
    delete() {
        this.gl.deleteTexture(this.dataBuffer);
    }

    /**
     * Updates the texture buffer with new data points
     * @param start Starting index in source data
     * @param n Number of points to sync
     * @param bufferPos Position in the texture buffer to start writing
     */
    syncPoints(start: number, n: number, bufferPos: number) {
        const dataPoints = this.dataPoints;
        
        // Calculate texture rows that need updating
        let rowStart = Math.floor(bufferPos / BUFFER_TEXTURE_WIDTH);
        let rowEnd = Math.ceil((bufferPos + n) / BUFFER_TEXTURE_WIDTH);
        
        // Add padding rows if we're at the start or end of data
        // This ensures smooth rendering at segment boundaries
        if (rowStart > 0 && start === 0 && 
            bufferPos === rowStart * BUFFER_TEXTURE_WIDTH)
            rowStart--;
        if (rowEnd < BUFFER_TEXTURE_HEIGHT && 
            start + n === dataPoints.length && 
            bufferPos + n === rowEnd * BUFFER_TEXTURE_WIDTH)
            rowEnd++;

        // Create temporary buffer for the update region
        const buffer = new Float32Array((rowEnd - rowStart) * BUFFER_TEXTURE_WIDTH * 2);
        
        // Fill buffer with data points
        for (let r = rowStart; r < rowEnd; r++) {
            for (let c = 0; c < BUFFER_TEXTURE_WIDTH; c++) {
                const p = r * BUFFER_TEXTURE_WIDTH + c;
                // Clamp source index to valid range
                const i = Math.max(Math.min(start + p - bufferPos, dataPoints.length - 1), 0);
                const dp = dataPoints[i];
                // Each point takes 2 slots (x,y) in the buffer
                const bufferIdx = ((r - rowStart) * BUFFER_TEXTURE_WIDTH + c) * 2;
                buffer[bufferIdx] = dp.x;
                buffer[bufferIdx + 1] = dp.y;
            }
        }
        
        // Update texture with new data
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowStart, 
            BUFFER_TEXTURE_WIDTH, rowEnd - rowStart, 
            gl.RG, gl.FLOAT, buffer);
    }

    /**
     * Renders the visible portion of this segment
     * @param renderInterval Range of points to render [start, end)
     * @param type Line rendering style (Line, Step, NativeLine, NativePoint)
     */
    draw(renderInterval: { start: number, end: number }, type: LineType) {
        // Clamp render range to buffer capacity
        const first = Math.max(0, renderInterval.start);
        const last = Math.min(BUFFER_INTERVAL_CAPACITY, renderInterval.end);
        const count = last - first;

        // Bind texture for rendering
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);

        // Draw based on line type
        if (type === LineType.Line) {
            // Each point generates 4 vertices for triangle strip
            gl.drawArrays(gl.TRIANGLE_STRIP, first * 4, 
                count * 4 + (last !== renderInterval.end ? 2 : 0));
        } else if (type === LineType.Step) {
            // Step lines need extra vertices for vertical segments
            let firstP = first * 4;
            let countP = count * 4 + 2;
            if (first === renderInterval.start) {
                firstP -= 2;
                countP += 2;
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, firstP, countP);
        } else if (type === LineType.NativeLine) {
            // Simple line strip using native GL lines
            gl.drawArrays(gl.LINE_STRIP, first, count + 1);
        } else if (type === LineType.NativePoint) {
            // Individual points
            gl.drawArrays(gl.POINTS, first, count + 1);
        }
    }
}

/**
 * An array of `SeriesSegmentVertexArray` to represent a series
 */
class SeriesVertexArray {
    private segments = [] as SeriesSegmentVertexArray[];
    // each segment has at least 2 points
    private validStart = 0;  // start position of the first segment. (0, BUFFER_INTERVAL_CAPACITY]
    private validEnd = 0;    // end position of the last segment. [2, BUFFER_POINT_CAPACITY)

    constructor(
        private gl: WebGL2RenderingContext,
        private series: TimeChartSeriesOptions,
    ) {
    }

    private popFront() {
        if (this.series.data.poped_front === 0)
            return;

        this.validStart += this.series.data.poped_front;

        while (this.validStart > BUFFER_INTERVAL_CAPACITY) {
            const activeArray = this.segments[0];
            activeArray.delete();
            this.segments.shift();
            this.validStart -= BUFFER_INTERVAL_CAPACITY;
        }

        this.segments[0].syncPoints(0, 0, this.validStart);
    }
    private popBack() {
        if (this.series.data.poped_back === 0)
            return;

        this.validEnd -= this.series.data.poped_back;

        while (this.validEnd < BUFFER_POINT_CAPACITY - BUFFER_INTERVAL_CAPACITY) {
            const activeArray = this.segments[this.segments.length - 1];
            activeArray.delete();
            this.segments.pop();
            this.validEnd += BUFFER_INTERVAL_CAPACITY;
        }

        this.segments[this.segments.length - 1].syncPoints(this.series.data.length, 0, this.validEnd);
    }

    private newArray() {
        return new SeriesSegmentVertexArray(this.gl, this.series.data);
    }
    private pushFront() {
        let numDPtoAdd = this.series.data.pushed_front;
        if (numDPtoAdd === 0)
            return;

        const newArray = () => {
            this.segments.unshift(this.newArray());
            this.validStart = BUFFER_POINT_CAPACITY;
        }

        if (this.segments.length === 0) {
            newArray();
            this.validEnd = this.validStart = BUFFER_POINT_CAPACITY - 1;
        }

        while (true) {
            const activeArray = this.segments[0];
            const n = Math.min(this.validStart, numDPtoAdd);
            activeArray.syncPoints(numDPtoAdd - n, n, this.validStart - n);
            numDPtoAdd -= this.validStart - (BUFFER_POINT_CAPACITY - BUFFER_INTERVAL_CAPACITY);
            this.validStart -= n;
            if (this.validStart > 0)
                break;
            newArray();
        }
    }

    private pushBack() {
        let numDPtoAdd = this.series.data.pushed_back;
        if (numDPtoAdd === 0)
            return

        const newArray = () => {
            this.segments.push(this.newArray());
            this.validEnd = 0;
        }

        if (this.segments.length === 0) {
            newArray();
            this.validEnd = this.validStart = 1;
        }

        while (true) {
            const activeArray = this.segments[this.segments.length - 1];
            const n = Math.min(BUFFER_POINT_CAPACITY - this.validEnd, numDPtoAdd);
            activeArray.syncPoints(this.series.data.length - numDPtoAdd, n, this.validEnd);
            // Note that each segment overlaps with the previous one.
            // numDPtoAdd can increase here, indicating the overlapping part should be synced again to the next segment
            numDPtoAdd -= BUFFER_INTERVAL_CAPACITY - this.validEnd;
            this.validEnd += n;
            // Fully fill the previous segment before creating a new one
            if (this.validEnd < BUFFER_POINT_CAPACITY)
                break;
            newArray();
        }
    }

    deinit() {
        for (const s of this.segments)
            s.delete();
        this.segments = [];
    }

    syncBuffer() {
        const d = this.series.data;
        if (d.length - d.pushed_back - d.pushed_front < 2) {
            this.deinit();
            d.poped_front = d.poped_back = 0;
        }
        if (this.segments.length === 0) {
            if (d.length >= 2) {
                if (d.pushed_back > d.pushed_front) {
                    d.pushed_back = d.length;
                    this.pushBack();
                } else {
                    d.pushed_front = d.length;
                    this.pushFront();
                }
            }
            return;
        }
        this.popFront();
        this.popBack();
        this.pushFront();
        this.pushBack();
    }

    // Implements view culling (only draws visible points).
    draw(renderDomain: { min: number, max: number }) {
        const data = this.series.data;
        // 1. First level of culling - entire series check
        if (this.segments.length === 0 || data[0].x > renderDomain.max || data[data.length - 1].x < renderDomain.min)
            return;
        // 2. Find visible data points using binary search
        const key = (d: DataPoint) => d.x
        // Find first visible point (subtract 1 to include point just before view)
        const firstDP = domainSearch(data, 1, data.length, renderDomain.min, key) - 1;
        // Find last visible point 
        const lastDP = domainSearch(data, firstDP, data.length - 1, renderDomain.max, key)
        // 3. Calculate buffer positions 
        const startInterval = firstDP + this.validStart;
        const endInterval = lastDP + this.validStart;

        // 4. Determine which segments contain visible points
        const startArray = Math.floor(startInterval / BUFFER_INTERVAL_CAPACITY);
        const endArray = Math.ceil(endInterval / BUFFER_INTERVAL_CAPACITY);

        // 5. Draw only the segments that contain visible points
        for (let i = startArray; i < endArray; i++) {
            const arrOffset = i * BUFFER_INTERVAL_CAPACITY
            this.segments[i].draw({
                start: startInterval - arrOffset,
                end: endInterval - arrOffset,
            }, this.series.lineType);
        }
    }
}

export class LineChartRenderer {
    private lineProgram = new LineProgram(this.gl, this.options.debugWebGL);
    private nativeLineProgram = new NativeLineProgram(this.gl, this.options.debugWebGL);
    private uniformBuffer;
    private arrays = new Map<TimeChartSeriesOptions, SeriesVertexArray>();
    private height = 0;
    private width = 0;
    private renderHeight = 0;
    private renderWidth = 0;

    constructor(
        private model: RenderModel,
        private gl: WebGL2RenderingContext,
        private options: ResolvedCoreOptions,
    ) {
        const uboSize = gl.getActiveUniformBlockParameter(this.lineProgram.program, 0, gl.UNIFORM_BLOCK_DATA_SIZE);
        this.uniformBuffer = new ShaderUniformData(this.gl, uboSize);

        model.updated.on(() => this.drawFrame());
        model.resized.on((w, h) => this.onResize(w, h));
    }

    syncBuffer() {
        for (const s of this.options.series) {
            let a = this.arrays.get(s);
            if (!a) {
                a = new SeriesVertexArray(this.gl, s);
                this.arrays.set(s, a);
            }
            a.syncBuffer();
        }
    }

    syncViewport() {
        this.renderWidth = this.width - this.options.renderPaddingLeft - this.options.renderPaddingRight;
        this.renderHeight = this.height - this.options.renderPaddingTop - this.options.renderPaddingBottom;

        const scale = vec2.fromValues(this.renderWidth, this.renderHeight)
        vec2.divide(scale, [2., 2.], scale)
        this.uniformBuffer.projectionScale.set(scale);
    }

    onResize(width: number, height: number) {
        this.height = height;
        this.width = width;
    }

    drawFrame() {
        // Sync buffer and domain.
        this.syncBuffer();
        this.syncDomain();
        // Upload uniform buffer.
        this.uniformBuffer.upload();
        const gl = this.gl;
        // Draw each series.
        for (const [ds, arr] of this.arrays) {
            // Skip invisible series.
            if (!ds.visible) {
                continue;
            }

            // Select program based on line type.
            const prog = ds.lineType === LineType.NativeLine || ds.lineType === LineType.NativePoint ? this.nativeLineProgram : this.lineProgram;
            prog.use();
            // Set color.
            const color = resolveColorRGBA(ds.color ?? this.options.color);
            gl.uniform4fv(prog.locations.uColor, color);
            // Set line width.
            const lineWidth = ds.lineWidth ?? this.options.lineWidth;
            if (prog instanceof LineProgram) {
                gl.uniform1i(prog.locations.uLineType, ds.lineType);
                gl.uniform1f(prog.locations.uLineWidth, lineWidth / 2);
                if (ds.lineType === LineType.Step)
                    gl.uniform1f(prog.locations.uStepLocation, ds.stepLocation);
            } else {
                if (ds.lineType === LineType.NativeLine)
                    gl.lineWidth(lineWidth * this.options.pixelRatio);  // Not working on most platforms
                else if (ds.lineType === LineType.NativePoint)
                    gl.uniform1f(prog.locations.uPointSize, lineWidth * this.options.pixelRatio);
            }

            // Calculate render domain with padding for line width.
            const renderDomain = {
                min: this.model.xScale.invert(this.options.renderPaddingLeft - lineWidth / 2),
                max: this.model.xScale.invert(this.width - this.options.renderPaddingRight + lineWidth / 2),
            };
            // Draw visible points.
            arr.draw(renderDomain);
        }
        // Check for WebGL errors.
        if (this.options.debugWebGL) {
            const err = gl.getError();
            if (err != gl.NO_ERROR) {
                throw new Error(`WebGL error ${err}`);
            }
        }
    }

    syncDomain() {
        this.syncViewport();
        const m = this.model;

        // for any x,
        // (x - domain[0]) / (domain[1] - domain[0]) * (range[1] - range[0]) + range[0] - W / 2 - padding = s * (x + t)
        // => s = (range[1] - range[0]) / (domain[1] - domain[0])
        //    t = (range[0] - W / 2 - padding) / s - domain[0]

        // Not using vec2 for precision
        const xDomain = m.xScale.domain();
        const xRange = m.xScale.range();
        const yDomain = m.yScale.domain();
        const yRange = m.yScale.range();
        const s = [
            (xRange[1] - xRange[0]) / (xDomain[1] - xDomain[0]),
            (yRange[0] - yRange[1]) / (yDomain[1] - yDomain[0]),
        ];
        const t = [
            (xRange[0] - this.renderWidth / 2 - this.options.renderPaddingLeft) / s[0] - xDomain[0],
            -(yRange[0] - this.renderHeight / 2 - this.options.renderPaddingTop) / s[1] - yDomain[0],
        ];

        this.uniformBuffer.modelScale.set(s);
        this.uniformBuffer.modelTranslate.set(t);
    }
}

export const lineChart: TimeChartPlugin<LineChartRenderer> = {
    apply(chart) {
        return new LineChartRenderer(chart.model, chart.canvasLayer.gl, chart.options);
    }
}
