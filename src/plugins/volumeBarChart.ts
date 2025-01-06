import { LinkedWebGLProgram, throwIfFalsy } from './webGLUtils';
import { resolveColorRGBA, ResolvedCoreOptions, TimeChartSeriesOptions, LineType } from '../options';


class ShaderUniformData {
    data;
    ubo;

    constructor(private gl: WebGL2RenderingContext, size: number) {
        this.data = new ArrayBuffer(size);
        this.ubo = throwIfFalsy(gl.createBuffer());
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
        gl.bufferData(gl.UNIFORM_BUFFER, this.data, gl.DYNAMIC_DRAW);
    }
    get modelScale() {
        return new Float32Array(this.data, 0, 2);
    }
    get modelTranslate() {
        return new Float32Array(this.data, 2 * 4, 2);
    }
    get projectionScale() {
        return new Float32Array(this.data, 4 * 4, 2);
    }

    upload(index = 0) {
        this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, index, this.ubo);
        this.gl.bufferSubData(this.gl.UNIFORM_BUFFER, 0, this.data);
    }
}

const BUFFER_TEXTURE_WIDTH = 256;
const BUFFER_TEXTURE_HEIGHT = 2048;


const LINE_FS_SOURCE = `#version 300 es
precision lowp float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
    outColor = uColor;
}`;



class VolumeBarProgram extends LinkedWebGLProgram {
    static VS_SOURCE = `#version 300 es
    layout (std140) uniform proj {
        vec2 modelScale;
        vec2 modelTranslate;
        vec2 projectionScale;
    };
    
    uniform highp sampler2D uDataPoints;
    uniform float uBarWidth;
    
    const int TEX_WIDTH = ${BUFFER_TEXTURE_WIDTH};
    const int TEX_HEIGHT = ${BUFFER_TEXTURE_HEIGHT};
    
    vec2 dataPoint(int index) {
        int x = index % TEX_WIDTH;
        int y = index / TEX_WIDTH;
        return texelFetch(uDataPoints, ivec2(x, y), 0).xy;
    }
    
    void main() {
        // Each bar uses 6 vertices (2 triangles)
        int barIndex = gl_VertexID / 6;
        int vertexIndex = gl_VertexID % 6;
        
        vec2 point = dataPoint(barIndex);
        float x = point.x;
        float height = point.y;
        
        // Calculate vertex position based on vertex index
        float xOffset = (vertexIndex == 1 || vertexIndex == 2 || vertexIndex == 5) ? uBarWidth : 0.0;
        float yOffset = (vertexIndex == 0 || vertexIndex == 1 || vertexIndex == 3) ? height : 0.0;
        
        vec2 position = vec2(x + xOffset, yOffset);
        vec2 transformed = projectionScale * modelScale * (position + modelTranslate);
        gl_Position = vec4(transformed, 0, 1);
    }`;

    locations;
    constructor(gl: WebGL2RenderingContext, debug: boolean) {
        super(gl, VolumeBarProgram.VS_SOURCE, LINE_FS_SOURCE, debug);
        this.link();

        this.locations = {
            uDataPoints: this.getUniformLocation('uDataPoints'),
            uBarWidth: this.getUniformLocation('uBarWidth'),
            uColor: this.getUniformLocation('uColor'),
        }

        this.use();
        gl.uniform1i(this.locations.uDataPoints, 0);
        const projIdx = gl.getUniformBlockIndex(this.program, 'proj');
        gl.uniformBlockBinding(this.program, projIdx, 0);
    }
}

class VolumeBarRenderer {
    private barProgram: VolumeBarProgram;
    private uniformBuffer: ShaderUniformData;
    private dataBuffer: WebGLTexture;
    private volumeData: Float32Array;
    private lastUpdateTime: number = 0;
    private aggregationPeriod: number = 1000; // 1 seconds in ms
    private numberOfBars: number = 0;
    private currentBarIndex: number = 0;

    constructor(
        private gl: WebGL2RenderingContext,
        private options: ResolvedCoreOptions
    ) {
        this.barProgram = new VolumeBarProgram(gl, options.debugWebGL);
        
        // Initialize uniform buffer
        this.uniformBuffer = new ShaderUniformData(gl, 6 * 4); // 6 floats * 4 bytes
        
        // Initialize texture for data points
        this.dataBuffer = throwIfFalsy(gl.createTexture());
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);
        
        // Initialize volume data array (x, y coordinates for each point)
        this.volumeData = new Float32Array(BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT * 2);
        
        // Initial texture setup
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RG32F,
            BUFFER_TEXTURE_WIDTH,
            BUFFER_TEXTURE_HEIGHT,
            0,
            gl.RG,
            gl.FLOAT,
            this.volumeData
        );
        
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }

    // add volume data
    addVolumeData(timestamp: number, volume: number) {
        // add new bar if necessary 
        if (this.lastUpdateTime === 0 || timestamp - this.lastUpdateTime > this.aggregationPeriod) {
            this.addNewBar(timestamp, volume);
        } else {
            this.updateCurrentBar(volume);
        }
    }

    private addNewBar(timestamp: number, volume: number) {
        const index = this.currentBarIndex * 2;
        this.volumeData[index] = timestamp;
        this.volumeData[index + 1] = volume;
        
        this.currentBarIndex = (this.currentBarIndex + 1) % (BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT);
        this.numberOfBars = Math.min(this.numberOfBars + 1, BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT);
        this.lastUpdateTime = timestamp;
        
        // Update texture with new data
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.dataBuffer);
        this.gl.texSubImage2D(
            this.gl.TEXTURE_2D,
            0,
            0,
            0,
            BUFFER_TEXTURE_WIDTH,
            BUFFER_TEXTURE_HEIGHT,
            this.gl.RG,
            this.gl.FLOAT,
            this.volumeData
        );
    }

    private updateCurrentBar(volume: number) {
        const index = ((this.currentBarIndex - 1 + BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT) 
            % (BUFFER_TEXTURE_WIDTH * BUFFER_TEXTURE_HEIGHT)) * 2;
        this.volumeData[index + 1] += volume; // Accumulate volume
        
        // Update texture with modified data
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.dataBuffer);
        this.gl.texSubImage2D(
            this.gl.TEXTURE_2D,
            0,
            0,
            0,
            BUFFER_TEXTURE_WIDTH,
            BUFFER_TEXTURE_HEIGHT,
            this.gl.RG,
            this.gl.FLOAT,
            this.volumeData
        );
    }

    draw() {
        const gl = this.gl;
        this.barProgram.use();

        // Bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataBuffer);

        // Update uniforms
        const timeOpts = this.options.time ?? {};
        this.uniformBuffer.modelScale.set([timeOpts.timeScale ?? 1.0, 1.0]);
        this.uniformBuffer.modelTranslate.set([timeOpts.timeRange?.min ?? 0, 0]);
        this.uniformBuffer.projectionScale.set([1, 1]);
        this.uniformBuffer.upload(0);

        // Set bar width based on time scale
        gl.uniform1f(this.barProgram.locations.uBarWidth, this.calculateBarWidth());
        gl.uniform4fv(this.barProgram.locations.uColor, [0.5, 0.5, 0.8, 0.6]);

        // Draw bars
        gl.drawArrays(gl.TRIANGLES, 0, this.numberOfBars * 6);
    }

    private calculateBarWidth() {
        // Calculate bar width based on time scale and aggregation period
        // This ensures bars scale appropriately when zooming
        return this.aggregationPeriod * ((this.options.time ?? {}).timeScale ?? 1.0);
    }

    // ... additional methods for managing data buffers and updates
} 

export const volumeBarChart: TimeChartPlugin<VolumeBarRenderer> = {
    apply(chart) {
        return new VolumeBarRenderer(chart.canvasLayer.gl, chart.options);
    }
}; 