import { DataPoint, RenderModel } from "../core/renderModel";
import { resolveColorRGBA, ResolvedCoreOptions, TimeChartSeriesOptions } from '../options';
import { LinkedWebGLProgram, throwIfFalsy } from './webGLUtils';
import { DataPointsBuffer } from "../core/dataPointsBuffer";
import { TimeChartPlugin } from '.';

// Add these constants after the imports
const BUFFER_TEXTURE_WIDTH = 256;
const BUFFER_TEXTURE_HEIGHT = 2048;

// Define HeatmapPoint to include intensity
interface HeatmapPoint extends DataPoint {
    x: number;
    y: number;
    intensity: number;  // Value determining color intensity
}

// First, add attribute locations
const ATTRIB_LOCATIONS = {
    POSITION: 0,
    POINT_INDEX: 1,
    CORNER_INDEX: 2,
} as const;

const VS_SOURCE = `#version 300 es
layout(location = ${ATTRIB_LOCATIONS.POSITION}) in vec2 position;
layout(location = ${ATTRIB_LOCATIONS.POINT_INDEX}) in float pointIndex;
layout(location = ${ATTRIB_LOCATIONS.CORNER_INDEX}) in float cornerIndex;

layout(std140) uniform proj {
    vec2 modelScale;
    vec2 modelTranslate;
    vec2 projectionScale;
};

uniform highp sampler2D uDataPoints;
uniform float uCellWidth;
uniform float uCellHeight;

out float v_pointIndex;  // Pass pointIndex to fragment shader

void main() {
    ivec2 texCoord = ivec2(
        int(pointIndex) % ${BUFFER_TEXTURE_WIDTH},
        int(pointIndex) / ${BUFFER_TEXTURE_WIDTH}
    );
    vec3 point = texelFetch(uDataPoints, texCoord, 0).xyz;
    
    float xOffset = mod(cornerIndex, 2.0) == 0.0 ? 0.0 : uCellWidth;
    float yOffset = cornerIndex >= 2.0 ? uCellHeight : 0.0;
    
    vec2 pos = vec2(point.x + xOffset, point.y + yOffset);
    vec2 transformedPos = projectionScale * modelScale * (pos + modelTranslate);
    
    gl_Position = vec4(transformedPos, 0.0, 1.0);
    v_pointIndex = pointIndex;  // Pass to fragment shader
}`;

const FS_SOURCE = `#version 300 es
precision highp float;

in float v_pointIndex;  // Receive pointIndex from vertex shader

uniform vec4 uColorHot;
uniform vec4 uColorCold;
uniform highp sampler2D uDataPoints;

out vec4 fragColor;

void main() {
    ivec2 texCoord = ivec2(
        int(v_pointIndex) % ${BUFFER_TEXTURE_WIDTH},
        int(v_pointIndex) / ${BUFFER_TEXTURE_WIDTH}
    );
    float intensity = texelFetch(uDataPoints, texCoord, 0).z;
    fragColor = mix(uColorCold, uColorHot, intensity);
}`;

class HeatmapProgram extends LinkedWebGLProgram {
    locations;

    constructor(gl: WebGL2RenderingContext, debug: boolean) {
        super(gl, VS_SOURCE, FS_SOURCE, debug);
        
        // Add error checking for shader compilation
        if (debug) {
            const linkError = gl.getProgramInfoLog(this.program);
            if (linkError) console.error('Program linking error:', linkError);
        }

        this.link();

        this.locations = {
            uDataPoints: this.getUniformLocation('uDataPoints'),
            uCellWidth: this.getUniformLocation('uCellWidth'),
            uCellHeight: this.getUniformLocation('uCellHeight'),
            uColorHot: this.getUniformLocation('uColorHot'),
            uColorCold: this.getUniformLocation('uColorCold')
        };

        this.use();
        gl.uniform1i(this.locations.uDataPoints, 0);
        const projIdx = gl.getUniformBlockIndex(this.program, 'proj');
        gl.uniformBlockBinding(this.program, projIdx, 0);
    }
}

export class HeatmapChartRenderer {
    private program: HeatmapProgram;
    private dataTexture: WebGLTexture;
    private dataPoints: HeatmapPoint[];

    constructor(
        private model: RenderModel,
        private gl: WebGL2RenderingContext,
        private options: ResolvedCoreOptions
    ) {
        this.program = new HeatmapProgram(gl, options.debugWebGL);
        this.dataTexture = this.createDataTexture();
        this.dataPoints = [];

        model.updated.on(() => this.drawFrame());
    }

    private createDataTexture(): WebGLTexture {
        const texture = throwIfFalsy(this.gl.createTexture());
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        // Initialize texture storage
        this.gl.texStorage2D(
            this.gl.TEXTURE_2D,
            1,
            this.gl.RGB32F,
            BUFFER_TEXTURE_WIDTH,
            BUFFER_TEXTURE_HEIGHT
        );
        return texture;
    }

    updateData(data: HeatmapPoint[]) {
        this.dataPoints = data;
        // Convert data to flat array format (x, y, intensity)
        const buffer = new Float32Array(data.length * 3);
        data.forEach((point, i) => {
            buffer[i * 3] = point.x;
            buffer[i * 3 + 1] = point.y;
            buffer[i * 3 + 2] = point.intensity;
        });

        // Update texture data
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.dataTexture);
        this.gl.texSubImage2D(
            this.gl.TEXTURE_2D,
            0,
            0,
            0,
            data.length,
            1,
            this.gl.RGB,
            this.gl.FLOAT,
            buffer
        );
    }

    drawFrame() {
        const gl = this.gl;
        this.program.use();

        // Set uniforms
        const heatmapOpts = this.options.heatmap ?? {};
        gl.uniform1f(this.program.locations.uCellWidth, heatmapOpts.cellWidth ?? 1.0);
        gl.uniform1f(this.program.locations.uCellHeight, heatmapOpts.cellHeight ?? 1.0);
        
        // Set colors for heat gradient
        gl.uniform4fv(this.program.locations.uColorHot, [1.0, 0.0, 0.0, 1.0]);  // Red
        gl.uniform4fv(this.program.locations.uColorCold, [0.0, 0.0, 1.0, 1.0]); // Blue

        // Bind data texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);

        // Draw quads
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4 * this.dataPoints.length);
    }
}

export const heatmapChart: TimeChartPlugin<HeatmapChartRenderer> = {
    apply(chart) {
        return new HeatmapChartRenderer(chart.model, chart.canvasLayer.gl, chart.options);
    }
}; 