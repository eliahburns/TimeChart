import { ResolvedCoreOptions } from '../options';
import { RenderModel } from './renderModel';

/**
 * Manages the SVG layer of the chart for rendering non-WebGL elements
 * Creates a full-size SVG element that overlays the WebGL canvas.
 * 
 * The SVG layer complements the WebGL rendering by providing a layer for non-WebGL elements like axes and labels.
 * 
 * Key Features:
 * - Shadow DOM Integration: Uses shadow DOM for style encapsulation
 * - Responsive Layout: Automatically resizes with the chart container
 * - Content Box Management: Provides a padded area for chart content
 * - Resource Cleanup: Properly removes elements when disposed
 * - Event-Driven Updates: Uses RenderModel's event system for coordination
 * 
 * The SVGLayer acts as a crucial bridge between WebGL-rendered data visualization and traditional SVG-based chart elements like axes, labels, and overlays.
 */
export class SVGLayer {
    // Root SVG element that contains all SVG-based chart elements
    svgNode: SVGSVGElement;

    /**
     * Creates a new SVG layer and attaches it to the shadow DOM
     * @param el Parent HTML element (chart container)
     * @param model RenderModel for handling chart lifecycle
     */
    constructor(el: HTMLElement, model: RenderModel) {
        // Create SVG element in the SVG namespace
        this.svgNode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        
        // Position SVG to cover entire container
        const style = this.svgNode.style;
        style.position = 'absolute';
        style.width = style.height = '100%';
        style.left = style.right = style.top = style.bottom = '0';
        
        // Attach to shadow DOM for encapsulation
        el.shadowRoot!.appendChild(this.svgNode);

        // Clean up SVG when model is disposed
        model.disposing.on(() => {
            el.shadowRoot!.removeChild(this.svgNode);
        })
    }
}

/**
 * Creates an SVG element that represents the content area of the chart
 * This area excludes padding and is used for elements like axes and grid lines
 */
export function makeContentBox(model: RenderModel, options: ResolvedCoreOptions) {
    // Create content area SVG
    const contentSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    contentSvg.classList.add('content-box')
    
    // Position content area accounting for padding
    contentSvg.x.baseVal.value = options.paddingLeft
    contentSvg.y.baseVal.value = options.paddingRight

    // Update content area size when chart is resized
    model.resized.on((width, height) => {
        contentSvg.width.baseVal.value = width - options.paddingRight - options.paddingLeft;
        contentSvg.height.baseVal.value = height - options.paddingTop - options.paddingBottom;
    })
    return contentSvg;
}
