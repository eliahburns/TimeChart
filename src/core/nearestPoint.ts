import { ResolvedCoreOptions, TimeChartSeriesOptions } from '../options';
import { domainSearch, EventDispatcher } from '../utils';
import { CanvasLayer } from './canvasLayer';
import { ContentBoxDetector } from "./contentBoxDetector";
import { DataPoint, RenderModel } from './renderModel';

/**
 * Manages the nearest point detection for hover interactions on the chart.
 * Tracks mouse position and finds the closest data points for each series.
 * 
 * This class is responsible for implementing hover interactions in the chart. Key features:
 * 
 * 1. **Mouse Position Tracking**
 *    - Converts mouse coordinates to canvas space
 *    - Handles mouse enter/leave events
 *    - Updates on mouse movement
 * 
 * 2. **Nearest Point Detection**
 *    - Uses binary search to find closest points efficiently
 *    - Considers both points before and after mouse position
 *    - Handles multiple series simultaneously
 * 
 * 3. **Visibility Management**
 *    - Only shows points within canvas bounds
 *    - Respects series visibility settings
 *    - Clears points when mouse leaves chart

 * 4. **Event Integration**
 *    - Coordinates with RenderModel for updates
 *    - Uses ContentBoxDetector for mouse events
 *    - Dispatches events when nearest points change

 * This functionality is typically used to:
 * - Display tooltips at nearest points
 * - Highlight data points on hover
 * - Show crosshairs or other hover effects
 * - Enable interactive data exploration
 * 
 * The class efficiently handles real-time updates and maintains smooth interaction even with large datasets.
 */
export class NearestPointModel {
    // Maps series to their nearest data point to the cursor
    dataPoints = new Map<TimeChartSeriesOptions, DataPoint>();
    // Current mouse position in canvas coordinates, null when mouse is outside
    lastPointerPos: null | {x: number, y: number} = null;

    // Event dispatcher for when nearest points are updated
    updated = new EventDispatcher();

    /**
     * Creates a new nearest point detection model
     * @param canvas The WebGL canvas layer
     * @param model The main render model for coordinate transforms
     * @param options Chart configuration options
     * @param detector Content box detector for mouse event handling
     */
    constructor(
        private canvas: CanvasLayer,
        private model: RenderModel,
        private options: ResolvedCoreOptions,
        detector: ContentBoxDetector
    ) {
        // Handle mouse movement within the chart
        detector.node.addEventListener('mousemove', ev => {
            // Convert mouse position to canvas coordinates
            const rect = canvas.canvas.getBoundingClientRect();
            this.lastPointerPos = {
                x: ev.clientX - rect.left,
                y: ev.clientY - rect.top,
            };
            this.adjustPoints();
        });

        // Handle mouse leaving the chart area
        detector.node.addEventListener('mouseleave', ev => {
            this.lastPointerPos = null;
            this.adjustPoints();
        });

        // Update nearest points when chart data changes
        model.updated.on(() => this.adjustPoints());
    }

    /**
     * Updates the nearest points for all visible series based on current mouse position
     * Called when:
     * - Mouse moves
     * - Mouse leaves chart
     * - Chart data updates
     */
    adjustPoints() {
        if (this.lastPointerPos === null) {
            // Clear all nearest points when mouse is outside chart
            this.dataPoints.clear();
        } else {
            // Convert mouse x-position to domain value (e.g., timestamp)
            const domain = this.model.xScale.invert(this.lastPointerPos.x);

            // Process each series in the chart
            for (const s of this.options.series) {
                // Skip empty or hidden series
                if (s.data.length == 0 || !s.visible) {
                    this.dataPoints.delete(s);
                    continue;
                }

                // Find index of nearest point using binary search
                const pos = domainSearch(s.data, 0, s.data.length, domain, d => d.x);
                const near: DataPoint[] = [];

                // Get points before and after the mouse position
                if (pos > 0) {
                    near.push(s.data[pos - 1]);
                }
                if (pos < s.data.length) {
                    near.push(s.data[pos]);
                }

                // Sort points by distance to mouse position
                const sortKey = (a: typeof near[0]) => Math.abs(a.x - domain);
                near.sort((a, b) => sortKey(a) - sortKey(b));

                // Convert nearest point to pixel coordinates
                const pxPoint = this.model.pxPoint(near[0]);
                const width = this.canvas.canvas.clientWidth;
                const height = this.canvas.canvas.clientHeight;

                // Only show point if it's within canvas bounds
                if (pxPoint.x <= width && pxPoint.x >= 0 &&
                    pxPoint.y <= height && pxPoint.y >= 0) {
                    this.dataPoints.set(s, near[0]);
                } else {
                    this.dataPoints.delete(s);
                }
            }
        }

        // Notify listeners that nearest points have been updated
        this.updated.dispatch();
    }
}
