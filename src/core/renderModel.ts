import { scaleLinear } from "d3-scale";
import { ResolvedCoreOptions, TimeChartSeriesOptions } from '../options';
import { EventDispatcher } from '../utils';

export interface DataPoint {
    x: number;
    y: number;
}

export interface MinMax { min: number; max: number; }

function calcMinMaxY(arr: DataPoint[], start: number, end: number): MinMax {
    let max = -Infinity;
    let min = Infinity;
    for (let i = start; i < end; i++) {
        const v = arr[i].y;
        if (v > max) max = v;
        if (v < min) min = v;
    }
    return { max, min };
}

function unionMinMax(...items: MinMax[]) {
    return {
        min: Math.min(...items.map(i => i.min)),
        max: Math.max(...items.map(i => i.max)),
    };
}

/**
 * Manages the rendering state and coordinate transformations for the chart.
 * Handles scaling, ranges, and updates for both time (x) and value (y) axes.
 */
export class RenderModel {
    // D3 scale objects for converting between data and pixel coordinates
    xScale = scaleLinear();
    yScale = scaleLinear();
    // Current data ranges for x and y axes
    xRange: MinMax | null = null;
    yRange: MinMax | null = null;

    /**
     * Initialize the model with chart options
     * Sets up initial axis ranges if specified in options
     */
    constructor(private options: ResolvedCoreOptions) {
        // Set initial x-axis domain if specified
        if (options.xRange !== 'auto' && options.xRange) {
            this.xScale.domain([options.xRange.min, options.xRange.max])
        }
        // Set initial y-axis domain if specified
        if (options.yRange !== 'auto' && options.yRange) {
            this.yScale.domain([options.yRange.min, options.yRange.max])
        }
    }

    // Event dispatcher for resize events
    resized = new EventDispatcher<(width: number, height: number) => void>();
    
    /**
     * Handle chart resize events
     * Updates scale ranges and triggers redraw
     */
    resize(width: number, height: number) {
        const op = this.options;
        // Update pixel ranges for scales, accounting for padding
        this.xScale.range([op.paddingLeft, width - op.paddingRight]);
        this.yScale.range([height - op.paddingBottom, op.paddingTop]);

        this.resized.dispatch(width, height)
        this.requestRedraw()
    }

    // Event dispatchers for updates and disposal
    updated = new EventDispatcher();
    disposing = new EventDispatcher();
    readonly abortController = new AbortController();

    /**
     * Clean up resources and abort pending operations
     */
    dispose() {
        if (!this.abortController.signal.aborted) {
            this.abortController.abort();
            this.disposing.dispatch();
        }
    }

    /**
     * Trigger model update and notify listeners
     */
    update() {
        this.updateModel();
        this.updated.dispatch();
        // Mark all series data as synced
        for (const s of this.options.series) {
            s.data._synced();
        }
    }

    /**
     * Update the model's scales based on current data
     * Handles both real-time and static updates
     */
    updateModel() {
        // Filter out empty series
        const series = this.options.series.filter(s => s.data.length > 0);
        if (series.length === 0) return;

        const o = this.options;

        // Update X-axis scaling
        {
            // Calculate domain bounds from all series
            const maxDomain = Math.max(...series.map(s => s.data[s.data.length - 1].x));
            const minDomain = Math.min(...series.map(s => s.data[0].x));
            this.xRange = { max: maxDomain, min: minDomain };

            if (this.options.realTime || o.xRange === 'auto') {
                if (this.options.realTime) {
                    // In real-time mode, maintain fixed width and shift domain
                    const currentDomain = this.xScale.domain();
                    const range = currentDomain[1] - currentDomain[0];
                    this.xScale.domain([maxDomain - range, maxDomain]);
                } else { // Auto mode
                    // Scale to fit all data
                    this.xScale.domain([minDomain, maxDomain]);
                }
            } else if (o.xRange) {
                // Use fixed range from options
                this.xScale.domain([o.xRange.min, o.xRange.max])
            }
        }

        // Update Y-axis scaling
        {
            // Calculate y-range including pushed data from both ends
            const minMaxY = series.flatMap(s => {
                return [
                    calcMinMaxY(s.data, 0, s.data.pushed_front),
                    calcMinMaxY(s.data, s.data.length - s.data.pushed_back, s.data.length),
                ];
            })
            if (this.yRange) {
                minMaxY.push(this.yRange);
            }
            this.yRange = unionMinMax(...minMaxY);

            if (o.yRange === 'auto') {
                // Auto-scale with nice round numbers
                this.yScale.domain([this.yRange.min, this.yRange.max]).nice();
            } else if (o.yRange) {
                // Use fixed range from options
                this.yScale.domain([o.yRange.min, o.yRange.max])
            }
        }
    }

    // Track redraw requests to prevent multiple queued updates
    private redrawRequested = false;

    /**
     * Request an animation frame update
     * Debounces multiple requests into single update
     */
    requestRedraw() {
        if (this.redrawRequested) return;
        
        this.redrawRequested = true;
        const signal = this.abortController.signal;
        requestAnimationFrame((time) => {
            this.redrawRequested = false;
            if (!signal.aborted) {
                this.update();
            }
        });
    }

    /**
     * Convert a data point to pixel coordinates
     */
    pxPoint(dataPoint: DataPoint) {
        return {
            x: this.xScale(dataPoint.x)!,
            y: this.yScale(dataPoint.y)!,
        }
    }
}
