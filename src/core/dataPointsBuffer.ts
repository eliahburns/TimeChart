import { DataPoint } from "./renderModel";

/**
 * Extends Array to track changes for GPU synchronization.
 * Maintains counters for pushed/popped elements at both ends of the array.
 * Used by SeriesVertexArray for efficient WebGL buffer management.
 * 
 * This class is crucial for managing data that needs to be synchronized with the GPU. It divides the buffer into three regions:
 * - Front Region: Recently pushed elements at the start
 * - Synced Region: Elements already synchronized with GPU
 * - Back Region: Recently pushed elements at the end
 * 
 * Key Features:
 * - Tracks modifications to both ends of the buffer
 * - Prevents modifications to the synced region
 * - Maintains counters for GPU synchronization
 * - Supports all standard array operations with sync awareness
 * - Throws errors for invalid operations that would corrupt GPU data
 * 
 * The implementation ensures that:
 * - GPU-synced data remains consistent
 * - Buffer modifications are properly tracked
 * - Memory operations are efficient
 * - Data integrity is maintained during all operations
 * 
 * This is particularly important for real-time data visualization where efficient GPU updates are crucial for performance.
 */
export class DataPointsBuffer<T = DataPoint> extends Array<T> {
    // Tracks elements added to the end
    pushed_back = 0;
    // Tracks elements added to the front
    pushed_front = 0;
    // Tracks elements removed from the end
    poped_back = 0;
    // Tracks elements removed from the front
    poped_front = 0;

    constructor(arrayLength: number);
    constructor(...items: T[]);
    constructor() {
        super(...arguments);
        // Initially mark all elements as pushed to back
        this.pushed_back = this.length;
    }

    /**
     * Resets all counters after GPU synchronization
     */
    _synced() {
        this.pushed_back = this.poped_back = this.pushed_front = this.poped_front = 0;
    }

    /**
     * Converts a regular array into a DataPointsBuffer
     * @param arr Source array or existing DataPointsBuffer
     * @returns DataPointsBuffer instance
     */
    static _from_array<T>(arr: Array<T> | DataPointsBuffer<T>): DataPointsBuffer<T> {
        if (arr instanceof DataPointsBuffer)
            return arr;
        // Convert array to DataPointsBuffer by changing its prototype
        const b = Object.setPrototypeOf(arr, DataPointsBuffer.prototype) as DataPointsBuffer<T>
        b.poped_back = b.pushed_front = b.poped_front = 0;
        b.pushed_back = b.length;  // Mark all elements as pushed to back
        return b;
    }

    /**
     * Adds elements to the end of the buffer
     * Updates pushed_back counter for GPU sync tracking
     */
    override push(...items: T[]): number {
        this.pushed_back += items.length;
        return super.push(...items);
    }

    /**
     * Removes and returns the last element
     * Updates counters based on where the element came from
     */
    override pop(): T | undefined {
        const len = this.length;
        const r = super.pop();
        if (r === undefined)
            return r;

        // Update counters based on which region the popped element was from
        if (this.pushed_back > 0)
            this.pushed_back--;  // Element was recently pushed
        else if (len - this.pushed_front > 0)
            this.poped_back++;   // Element was from synced region
        else
            this.pushed_front--; // Element was from front-pushed region
        return r;
    }

    /**
     * Adds elements to the start of the buffer
     * Updates pushed_front counter for GPU sync tracking
     */
    override unshift(...items: T[]): number {
        this.pushed_front += items.length;
        return super.unshift(...items);
    }

    /**
     * Removes and returns the first element
     * Updates counters based on where the element came from
     */
    override shift(): T | undefined {
        const len = this.length;
        const r = super.shift();
        if (r === undefined)
            return r;

        // Update counters based on which region the shifted element was from
        if (this.pushed_front > 0)
            this.pushed_front--; // Element was recently pushed to front
        else if (len - this.pushed_back > 0)
            this.poped_front++;  // Element was from synced region
        else
            this.pushed_back--; // Element was from back-pushed region
        return r;
    }

    /**
     * Updates counters for element deletion
     * Ensures GPU-synced regions aren't modified incorrectly
     */
    private updateDelete(start: number, deleteCount: number, len: number) {
        if (deleteCount === 0)
            return;

        // Helper function to track remaining items to delete
        const d = (c: number) => {
            deleteCount -= c;
            len -= c;
            return deleteCount === 0;
        }

        // Case 1: Deleting from pushed_front region
        if (start < this.pushed_front) {
            const c = Math.min(deleteCount, this.pushed_front - start);
            this.pushed_front -= c;
            if (d(c)) return;
        }

        // Case 2: Deleting from start of synced region
        if (start === this.pushed_front) {
            const c = Math.min(deleteCount, len - this.pushed_front - this.pushed_back);
            this.poped_front += c
            if (d(c)) return;
        }

        // Case 3: Deleting from middle of synced region
        if (start > this.pushed_front && start < len - this.pushed_back) {
            // Prevent deletion from middle of synced region unless it extends to the end
            if (start + deleteCount < len - this.pushed_back)
                throw new RangeError("DataPoints that already synced to GPU cannot be delete in the middle");
            const c = Math.min(deleteCount, len - start - this.pushed_back);
            this.poped_back += c;
            if (d(c)) return;
        }

        // Case 4: Deleting from pushed_back region
        const c = Math.min(deleteCount, len - start);
        this.pushed_back -= c;
        if (d(c)) return;

        throw new Error('BUG');
    }

    /**
     * Updates counters for element insertion
     * Ensures elements are only inserted at buffer ends
     */
    private updateInsert(start: number, insertCount: number, len: number) {
        if (start <= this.pushed_front) {
            this.pushed_front += insertCount;  // Insert at front
        } else if (start >= len - this.pushed_back) {
            this.pushed_back += insertCount;   // Insert at back
        } else {
            // Prevent insertion in synced region
            throw new RangeError("DataPoints cannot be inserted in the middle of the range that is already synced to GPU");
        }
    }

    /**
     * Implements array splice with GPU synchronization awareness
     * Handles both deletion and insertion of elements
     */
    override splice(start: number, deleteCount?: number, ...items: T[]): T[] {
        // Normalize start index
        if (start === -Infinity)
            start = 0
        else if (start < 0)
            start = Math.max(this.length + start, 0);

        // Normalize deleteCount
        if (deleteCount === undefined)
            deleteCount = this.length - start;
        else
            deleteCount = Math.min(Math.max(deleteCount, 0), this.length - start);

        // Update counters for deletion and insertion
        this.updateDelete(start, deleteCount, this.length);
        this.updateInsert(start, items.length, this.length - deleteCount);

        // Verify length after operation
        const expectedLen = this.length - deleteCount + items.length;
        const r = super.splice(start, deleteCount, ...items);
        if (this.length !== expectedLen)
            throw new Error(`BUG! length after splice not expected. ${this.length} vs ${expectedLen}`);
        return r;
    }
}
