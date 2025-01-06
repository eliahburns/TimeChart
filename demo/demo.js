main();

function getHLines(num, lineWidth) {
    const lines = [];
    // Create a color interpolator between two colors
    const colorScale = d3.scaleLinear()
    .domain([0, num-1])
    .range(['#ff0000', '#00ff00'])  // You can change these colors to define your gradient
    .interpolate(d3.interpolateHcl);  // Using HCL interpolation for smooth transitions

    for (let i = 0; i < num; i++) {
        lines.push(
            {
                name: 'HLine',
                data: [],
                lineWidth: lineWidth,
                color: colorScale(i),
                // lineType: TimeChart.LineType.NativePoint,
                // lineType: TimeChart.LineType.NativeLine,
            }
        );
    }
    return lines;
}


function main() {
    const el = document.getElementById('chart');
    const dataSin = [];
    const dataSin2 = [];
    const dataCos = [];
    const dataCos2 = [];
    const numHLines = 100;
    const hLineWidth = 5; 
    const HLines = getHLines(numHLines, hLineWidth);

    const dataSinLowerChart = [];

    const baseTime = Date.now() - performance.now()
    const chart = new TimeChart(el, {
        // debugWebGL: true,
        // forceWebGL1: true,
        baseTime,
        series: [
            ...HLines,
            {
                name: 'Sin',
                data: dataSin,
                lineWidth: 2,
            },
            {
                name: 'Sin2',
                data: dataSin2,
                color: 'green',
                lineWidth: 2,
            },
            {
                name: 'Cos',
                data: dataCos,
                lineWidth: 2,
                color: 'red',
            },
            {
                name: 'Cos2',
                data: dataCos2,
                lineWidth: 2,
                color: 'blue',
            },
        ],
        xRange: { min: 0, max: 20 * 1000 },
        realTime: true,

        xScaleType: d3.scaleLinear,
        plugins: {
            lineChart: TimeChart.plugins.lineChart,
            d3Axis: TimeChart.plugins.d3Axis,
            zoom: new TimeChart.plugins.TimeChartZoomPlugin({
                x: { autoRange: true },
                y: { autoRange: true },
                panMouseButtons: 4,
                touchMinPoints: 2,
            }),
            selectZoom: new TimeChart.plugins_extra.SelectZoomPlugin({
                cancelOnSecondPointer: true,
            }),
        },
        tooltip: {
            enabled: true,
            xFormatter: (x) => new Date(x + baseTime).toLocaleString([], {hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3}),
        },
    });

    const el2 = document.getElementById('chart-2');
    const chart2 = new TimeChart(el2, {
        // debugWebGL: true,
        // forceWebGL1: true,
        baseTime,
        series: [
            {
                name: 'Sin',
                data: dataSinLowerChart,
                lineWidth: 2,
            },
        ],
        xRange: { min: 0, max: 20 * 1000 },
        realTime: true,

        xScaleType: d3.scaleLinear,
        plugins: {
            lineChart: TimeChart.plugins.lineChart,
            d3Axis: TimeChart.plugins.d3Axis,
            zoom: new TimeChart.plugins.TimeChartZoomPlugin({
                x: { autoRange: true },
                y: { autoRange: true },
                panMouseButtons: 4,
                touchMinPoints: 2,
            }),
            selectZoom: new TimeChart.plugins_extra.SelectZoomPlugin({
                cancelOnSecondPointer: true,
            }),
        },
        tooltip: {
            enabled: true,
            xFormatter: (x) => new Date(x + baseTime).toLocaleString([], {hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3}),
        },
    });


    const pointCountEl = document.getElementById('point-count');

    let x = performance.now() - 20*1000;

    // Add volume chart
    // const volumeEl = document.getElementById('volume-chart');

    // const volumeChart = new TimeChart(volumeEl, {
    //     debugWebGL: true,
    //     baseTime,
    //     series: [],
    //     plugins: {
    //         volumeBar: TimeChart.plugins.volumeBarChart
    //     },
    //     time: {
    //         timeScale: 1.0,
    //         timeRange: { min: 0, max: 20 * 1000 }
    //     },
    //     xRange: { min: 0, max: 20 * 1000 },
    //     realTime: true,
    // });

    function update() {
        const time = performance.now();
        for (; x < time; x += 1) {
            // const y = Math.random() * 500 + 100;
            const y_sin = Math.sin(x * 0.002) * 320;
            dataSin.push({ x, y: y_sin });

            dataSinLowerChart.push({ x, y: y_sin });

            const y_sin2 = Math.sin(x * 0.0025) * 320;
            dataSin2.push({ x, y: y_sin2 });

            const y_cos = Math.cos(x * 0.002) * 200;
            dataCos.push({ x, y: y_cos });

            const y_cos2 = Math.cos(x * 0.0025) * 200;
            dataCos2.push({ x, y: y_cos2 });

            for (let i = 0; i < numHLines; i++) {
                const spacing = hLineWidth / 2;
                const y = -350 + i * spacing;
                HLines[i].data.push({ x, y: y });
            }

            // Add random volume data
            // const volume = Math.random() * 100;  // Random volume between 0-100
            // volumeChart.plugins.volumeBar.addVolumeData(x, volume);
        }
        pointCountEl.innerText = dataSin.length * (numHLines + 5);
        chart.update();
        chart2.update();
        // volumeChart.update();
    }

    function updateChart(chart) {
        const ev = setInterval(update, 1);
        document.getElementById('stop-btn').addEventListener('click', function () {
            clearInterval(ev);
        });
        document.getElementById('follow-btn').addEventListener('click', function () {
            chart.options.realTime = true;
            // volumeChart.options.realTime = true;
        });
        document.getElementById('legend-btn').addEventListener('click', function () {
            chart.options.legend = !chart.options.legend;
            chart.update();
        });
        document.getElementById('tooltip-btn').addEventListener('click', function () {
            chart.options.tooltip.enabled = !chart.options.tooltip.enabled;
        });

        paddingDirs = ['Top', 'Right', 'Bottom', 'Left'];
        for (const d of paddingDirs) {
            const i = document.getElementById('padding-' + d.toLowerCase());
            const propName = 'padding' + d
            i.textContent = chart.options[propName];
        }
        for (const d of paddingDirs) {
            /** @type {HTMLInputElement} */
            const i = document.getElementById('render-padding-' + d.toLowerCase());
            const propName = 'renderPadding' + d
            i.value = chart.options[propName];
            i.addEventListener('change', () => {
                chart.options[propName] = parseFloat(i.value);
                chart.update();
            });
        }
    }


    updateChart(chart);
    updateChart(chart2);
    // const ev = setInterval(update, 1);
    // document.getElementById('stop-btn').addEventListener('click', function () {
    //     clearInterval(ev);
    // });
    // document.getElementById('follow-btn').addEventListener('click', function () {
    //     chart.options.realTime = true;
    //     // volumeChart.options.realTime = true;
    // });
    // document.getElementById('legend-btn').addEventListener('click', function () {
    //     chart.options.legend = !chart.options.legend;
    //     chart.update();
    // });
    // document.getElementById('tooltip-btn').addEventListener('click', function () {
    //     chart.options.tooltip.enabled = !chart.options.tooltip.enabled;
    // });

    // paddingDirs = ['Top', 'Right', 'Bottom', 'Left'];
    // for (const d of paddingDirs) {
    //     const i = document.getElementById('padding-' + d.toLowerCase());
    //     const propName = 'padding' + d
    //     i.textContent = chart.options[propName];
    // }
    // for (const d of paddingDirs) {
    //     /** @type {HTMLInputElement} */
    //     const i = document.getElementById('render-padding-' + d.toLowerCase());
    //     const propName = 'renderPadding' + d
    //     i.value = chart.options[propName];
    //     i.addEventListener('change', () => {
    //         chart.options[propName] = parseFloat(i.value);
    //         chart.update();
    //     });
    // }
}
