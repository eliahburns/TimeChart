main();

function main() {
    // Create some test data for the heatmap
    function createHeatmapData() {
        const data = [];
        const now = Date.now();
        // Create 100 time slices
        for (let t = 0; t < 100; t++) {
            // Create 50 price levels
            for (let p = 0; p < 50; p++) {
                data.push({
                    x: now + t * 1000, // Each slice 1 second apart
                    y: 5000 + p * 10,  // Price levels 10 units apart
                    intensity: Math.random() // Random intensity between 0-1
                });
            }
        }
        return data;
    }

    const el = document.getElementById('chart');
    // Create chart instance with element as first argument
    const chart = new TimeChart(el, {
        plugins: {
            heatmap: TimeChart.plugins.heatmapChart
        },
        series: [],
        heatmap: {
            cellWidth: 10,
            cellHeight: 5,
            colorHot: '#ff0000',
            colorCold: '#0000ff'
        },
        debugWebGL: true
    });

    // Update with test data
    chart.updateData(createHeatmapData());
}