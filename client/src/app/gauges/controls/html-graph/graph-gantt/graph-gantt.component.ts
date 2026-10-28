import { Component, ViewChild, Input, Output, EventEmitter } from '@angular/core';
import { DaqQuery } from '../../../../_models/hmi';
import { ChartDataset, ChartType } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import DataLabelsPlugin from 'chartjs-plugin-datalabels';
import { GraphBarProperty, GraphSource } from '../../../../_models/graph';
import { GraphBaseComponent, GraphOptions, GraphThemeType } from '../graph-base/graph-base.component';

@Component({
    selector: 'graph-gantt',
    templateUrl: './graph-gantt.component.html',
    styleUrls: ['./graph-gantt.component.css']
})
export class GraphGanttComponent extends GraphBaseComponent {
    @ViewChild(BaseChartDirective, {static: false}) public chart?: BaseChartDirective;
    @Input() height = 240;
    @Input() width = 380;
    // [CUSTOM] Request historical DAQ values through the existing FUXA graph flow
    @Output() onReload: EventEmitter<DaqQuery> = new EventEmitter();

    title = '';
    id = '';
    isEditor = false;
    property: GraphBarProperty;
    // [CUSTOM] Map FUXA Tag IDs to Gantt lanes
    sourceMap = {};
    // [CUSTOM] Store DAQ state changes for each Gantt source
    private historyChanges = {};
    private liveValues = {};
    // [CUSTOM] Keep current Gantt interval state for O(1) live updates
    private laneStates = {};
    // [CUSTOM] Current time position updated continuously
    private currentTimeMs = Date.now();

    // [CUSTOM] X-axis range mode
    private xAxisMode: 'rolling' | 'fixed' = 'rolling';

    // [CUSTOM] Gantt X-axis window range
    private xAxisFrom: number;
    private xAxisTo: number;

    // [CUSTOM] Keep the configured window width for Rolling mode
    private xAxisWindowMs: number;
    
    public ganttChartType: ChartType = 'bar';

    public ganttChartLabels = [
        'Machine A'
    ];

    // [CUSTOM] Draw current time marker on the Gantt chart
    private currentTimePlugin = {
        id: 'currentTimeLine',
        afterDraw: (chart: any) => {
            const x = chart.scales.x.getPixelForValue(this.currentTimeMs);

            if (x < chart.chartArea.left || x > chart.chartArea.right) {
                return;
            }

            const ctx = chart.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, chart.chartArea.top);
            ctx.lineTo(x, chart.chartArea.bottom);
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#DC2626';
            ctx.stroke();
            ctx.restore();
        }
    };

    public ganttChartPlugins = [
        DataLabelsPlugin,
        this.currentTimePlugin
    ];

    // [CUSTOM] Temporary datetime data used to verify one Gantt lane
    public ganttChartData: any[] = [
        {
            label: 'State 0',
            data: [[
                new Date('2026-10-25T08:00:00').getTime(),
                new Date('2026-10-25T09:00:00').getTime()
            ]],
            backgroundColor: '#6B7280',
            grouped: false
        },
        {
            label: 'State 1',
            data: [[
                new Date('2026-10-25T09:00:00').getTime(),
                new Date('2026-10-25T11:00:00').getTime()
            ]],
            backgroundColor: '#16A34A',
            grouped: false
        },
        {
            label: 'State 2',
            data: [[
                new Date('2026-10-25T11:00:00').getTime(),
                new Date('2026-10-25T13:00:00').getTime()
            ]],
            backgroundColor: '#F59E0B',
            grouped: false
        },
        {
            label: 'State 3',
            data: [[
                new Date('2026-10-25T13:00:00').getTime(),
                new Date('2026-10-25T15:00:00').getTime()
            ]],
            backgroundColor: '#DC2626',
            grouped: false
        }
    ];

    public ganttChartOptions: GraphOptions = GraphGanttComponent.DefaultOptions();

    // [CUSTOM] Normalize DAQ and live timestamps to Unix milliseconds
    private toMilliseconds(timestamp: number): number {
        return timestamp < 100000000000 ? timestamp * 1000 : timestamp;
    }

    constructor() {
        super();
        // [CUSTOM] Temporary debug
        console.log('[GraphGantt] constructor');
    }

    // [CUSTOM] Initialize Gantt graph from the existing FUXA graph configuration
    init(title: string, property: GraphBarProperty, sources?: GraphSource[]) {
        this.title = title;
        this.property = property;

        if (sources) {
            this.setSources(sources);
        }
    }

    // [CUSTOM] Register FUXA graph sources as Gantt lanes
    setSources(sources: GraphSource[]) {
        this.sourceMap = {};

        for (let i = 0; i < sources.length; i++) {
            this.sourceMap[sources[i].id] = {
                label: sources[i].label,
                source: sources[i]
            };
        }

        // [CUSTOM] Use source labels as Gantt lane labels
        if (sources.length > 0) {
            setTimeout(() => {
                this.ganttChartLabels = sources.map(source => source.label);
            });
        }
    }

    setOptions(options: GraphOptions): void {
        if (options) {
            this.ganttChartOptions = { ...this.ganttChartOptions, ...options };

            // [CUSTOM] Apply saved Gantt time range settings
            const ganttOptions = this.ganttChartOptions as any;
            // [CUSTOM] Apply configured state names and colors to the Gantt preview
            if (this.isEditor && ganttOptions.stateNames && ganttOptions.stateColors) {
                for (let i = 0; i < this.ganttChartData.length; i++) {
                    this.ganttChartData[i].label = ganttOptions.stateNames[i] ?? `State ${i}`;
                    this.ganttChartData[i].backgroundColor = ganttOptions.stateColors[i] ?? '#6B7280';
                }
            }
            this.xAxisMode = ganttOptions.rangeMode ?? 'rolling';

            const rangeFrom = new Date(ganttOptions.rangeFrom).getTime();
            const rangeTo = new Date(ganttOptions.rangeTo).getTime();

            if (Number.isFinite(rangeFrom) && Number.isFinite(rangeTo) && rangeTo > rangeFrom) {
                this.xAxisFrom = rangeFrom;
                this.xAxisTo = rangeTo;
                this.xAxisWindowMs = rangeTo - rangeFrom;

                this.ganttChartOptions.scales.x.min = this.xAxisFrom;
                this.ganttChartOptions.scales.x.max = this.xAxisTo;
            }
        }
        this.ganttChartOptions.scales.x.ticks.callback = (value) => {
            const date = new Date(Number(value));

            return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} `
                + `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
        };
        if (this.chart) {
            this.chart.update();
        }
        // [CUSTOM] Request Gantt history after graph initialization
        if (!this.isEditor) {
            setTimeout(() => {
                console.log('[GraphGantt] refresh');
                this.onRefresh();
            }, 500);
        }
    }
    // [CUSTOM] Change X-axis range mode
    setXAxisMode(mode: 'rolling' | 'fixed', rangeFrom?: number, rangeTo?: number) {
        this.xAxisMode = mode;

        if (rangeFrom !== undefined) {
            this.xAxisFrom = rangeFrom;
        }

        if (rangeTo !== undefined) {
            this.xAxisTo = rangeTo;
        }

        if (this.xAxisTo > this.xAxisFrom) {
            this.xAxisWindowMs = this.xAxisTo - this.xAxisFrom;
        }
    }
    
    resize(height?, width?) {
        if (height && width) {
            this.height = height;
            this.width = width;

            if (this.ganttChartOptions.panel) {
                this.ganttChartOptions.panel.height = height;
                this.ganttChartOptions.panel.width = width;
            }
        }
    }

    // [CUSTOM] Request Gantt history data through the existing FUXA DAQ flow
    onRefresh() {
        if (this.isEditor || !this.property) {
            return false;
        }

        const query = new DaqQuery();
        const now = Date.now();

        query.gid = this.id;

        // [CUSTOM] Advance Rolling mode by complete fixed-width windows
        if (this.xAxisMode === 'rolling' && this.xAxisWindowMs > 0 && now >= this.xAxisTo) {
            const windowOffset = Math.floor((now - this.xAxisFrom) / this.xAxisWindowMs);

            this.xAxisFrom += windowOffset * this.xAxisWindowMs;
            this.xAxisTo = this.xAxisFrom + this.xAxisWindowMs;
        }

        this.ganttChartOptions.scales.x.min = this.xAxisFrom;
        this.ganttChartOptions.scales.x.max = this.xAxisTo;

        query.from = this.xAxisFrom;
        query.to = Math.min(this.xAxisTo, now);
        query.sids = Object.keys(this.sourceMap);

        this.onReload.emit(query);
    }

    setValues(sigsid: string[], sigsvalues: any) {
        // [CUSTOM] Store DAQ state changes for every Gantt source
        for (let sourceIndex = 0; sourceIndex < sigsid.length; sourceIndex++) {
            const sigid = sigsid[sourceIndex];
            const values = sigsvalues?.[sourceIndex];

            // [CUSTOM] Convert configured No Data interval to milliseconds
            const noDataIntervalSec = Number((this.ganttChartOptions as any).noDataIntervalSec);
            const noDataIntervalMs = Number.isFinite(noDataIntervalSec) && noDataIntervalSec > 0 ? noDataIntervalSec * 1000 : 0;

            if (!values || values.length === 0) {
                continue;
            }

            const changes = [];

            for (let i = 0; i < values.length; i++) {
                const currentDt = this.toMilliseconds(Number(values[i].dt));
                const currentValue = String(values[i].value);
                const previousDt = i > 0 ? this.toMilliseconds(Number(values[i - 1].dt)) : currentDt;
                const previousValue = i > 0 ? String(values[i - 1].value) : currentValue;
                const hasNoDataGap = i > 0 && noDataIntervalMs > 0 && currentDt - previousDt > noDataIntervalMs;

                if (i === 0 || currentValue !== previousValue || hasNoDataGap) {
                    changes.push({
                        ...values[i],
                        value: currentValue,
                        noDataGap: hasNoDataGap,
                        noDataFrom: hasNoDataGap ? previousDt + noDataIntervalMs : null
                    });
                }
            }

            // [CUSTOM] Keep the latest raw DAQ timestamp even when same-state records are compressed
            if (changes.length > 0) {
                changes[changes.length - 1].lastSeenDt = this.toMilliseconds(Number(values[values.length - 1].dt));
            }

            this.historyChanges[sigid] = changes;

            // [CUSTOM] Initialize the current lane state from the latest DAQ state change
            const lastChange = changes[changes.length - 1];

            if (lastChange) {
                const lastChangeDt = this.toMilliseconds(Number(lastChange.dt));
                const laneState = this.laneStates[sigid];

                // [CUSTOM] Do not overwrite a newer live state with older DAQ data
                if (!laneState || lastChangeDt > laneState.currentEnd) {
                    this.laneStates[sigid] = {
                        currentState: String(lastChange.value),
                        currentStart: lastChangeDt,
                        currentEnd: lastChangeDt,
                        datasetIndex: -1,
                        dataIndex: -1
                    };
                }
            }
        }

        // [CUSTOM] Build historical Gantt intervals once from DAQ state changes
        const ganttOptions = this.ganttChartOptions as any;
        const sourceIds = Object.keys(this.sourceMap);
        const datasets: any[] = [];

        for (let stateIndex = 0; stateIndex < ganttOptions.stateCount; stateIndex++) {
            datasets.push({
                label: ganttOptions.stateNames?.[stateIndex] ?? `State ${stateIndex}`,
                data: [],
                backgroundColor: ganttOptions.stateColors?.[stateIndex] ?? '#6B7280',
                grouped: false
            });
        }

        for (let sourceIndex = 0; sourceIndex < sourceIds.length; sourceIndex++) {
            const sourceId = sourceIds[sourceIndex];
            const changes = this.historyChanges[sourceId];

            if (!changes?.length) {
                continue;
            }

            for (let changeIndex = 0; changeIndex < changes.length - 1; changeIndex++) {
                const stateValue = Number(changes[changeIndex].value);

                if (!Number.isInteger(stateValue) || stateValue < 0 || stateValue >= datasets.length) {
                    continue;
                }

                const start = this.toMilliseconds(Number(changes[changeIndex].dt));
                const end = changes[changeIndex + 1].noDataGap
                    ? Number(changes[changeIndex + 1].noDataFrom)
                    : this.toMilliseconds(Number(changes[changeIndex + 1].dt));

                datasets[stateValue].data.push({
                    x: [start, end],
                    y: this.sourceMap[sourceId]?.label ?? sourceId
                });
            }
        }

        // [CUSTOM] Add current intervals and cache their positions
        for (const sourceId of sourceIds) {
            const changes = this.historyChanges[sourceId];

            if (!changes?.length) {
                continue;
            }

            const last = changes[changes.length - 1];
            const stateValue = Number(last.value);
            const start = this.toMilliseconds(Number(last.dt));

            // [CUSTOM] Treat -1 as No Data and keep the lane without an active dataset
            if (!Number.isInteger(stateValue) || stateValue < 0 || stateValue >= datasets.length) {
                this.laneStates[sourceId] = {
                    currentState: String(last.value),
                    currentStart: start,
                    currentEnd: start,
                    datasetIndex: -1,
                    dataIndex: -1
                };
                continue;
            }

            const dataIndex = datasets[stateValue].data.length;

            // [CUSTOM] Stop the latest historical interval when DAQ data becomes stale
            const noDataIntervalSec = Number((this.ganttChartOptions as any).noDataIntervalSec);
            const noDataIntervalMs = Number.isFinite(noDataIntervalSec) && noDataIntervalSec > 0 ? noDataIntervalSec * 1000 : 0;
            const lastSeenDt = Number(last.lastSeenDt ?? start);
            const end = noDataIntervalMs > 0 ? Math.min(this.currentTimeMs, lastSeenDt + noDataIntervalMs) : this.currentTimeMs;

            datasets[stateValue].data.push({
                x: [start, end],
                y: this.sourceMap[sourceId]?.label ?? sourceId
            });

            this.laneStates[sourceId] = {
                currentState: String(last.value),
                currentStart: start,
                currentEnd: end,
                datasetIndex: stateValue,
                dataIndex: dataIndex
            };
        }

        this.ganttChartData = datasets;
    }

    // [CUSTOM] Receive current live Tag value through the existing FUXA graph flow
    setValue(sigid: string, timestamp: any, sigvalue: any) {
        const timestampMs = this.toMilliseconds(Number(timestamp));
        const now = Date.now();

        this.currentTimeMs = now;

        // [CUSTOM] Advance Rolling mode only when the current Window has ended
        if (this.xAxisMode === 'rolling' && this.xAxisWindowMs > 0 && now >= this.xAxisTo) {
            const windowOffset = Math.floor((now - this.xAxisFrom) / this.xAxisWindowMs);

            this.xAxisFrom += windowOffset * this.xAxisWindowMs;
            this.xAxisTo = this.xAxisFrom + this.xAxisWindowMs;
        }

        this.ganttChartOptions.scales.x.min = this.xAxisFrom;
        this.ganttChartOptions.scales.x.max = this.xAxisTo;

        // [CUSTOM] Keep the start timestamp of the current live state
        const previousLive = this.liveValues[sigid];
        const currentValue = String(sigvalue);

        if (!previousLive) {
            const history = this.historyChanges[sigid];
            const lastHistory = history?.length > 0 ? history[history.length - 1] : null;

            this.liveValues[sigid] = {
                dt: timestampMs,
                startDt: lastHistory && String(lastHistory.value) === currentValue ? lastHistory.dt : timestampMs,
                value: currentValue
            };
        } else if (String(previousLive.value) !== currentValue) {
            this.liveValues[sigid] = {
                dt: timestampMs,
                startDt: timestampMs,
                value: currentValue
            };
        } else {
            this.liveValues[sigid] = {
                ...previousLive,
                dt: timestampMs
            };
        }

        const history = this.historyChanges[sigid];
        const laneState = this.laneStates[sigid];

        // [CUSTOM] Treat -1 as No Data and close the active interval immediately
        if (currentValue === '-1') {
            if (laneState && laneState.datasetIndex >= 0 && laneState.dataIndex >= 0) {
                const activeDataset = this.ganttChartData[laneState.datasetIndex];
                const activePoint = activeDataset?.data?.[laneState.dataIndex];

                if (activePoint) {
                    activePoint.x[1] = timestampMs;
                }
            }

            // [CUSTOM] Store only live state changes instead of every live sample
            if (!history || history.length === 0 || String(history[history.length - 1].value) !== currentValue) {
                if (!this.historyChanges[sigid]) {
                    this.historyChanges[sigid] = [];
                }

                this.historyChanges[sigid].push({
                    dt: timestampMs,
                    value: currentValue
                });
            }

            this.laneStates[sigid] = {
                currentState: currentValue,
                currentStart: timestampMs,
                currentEnd: timestampMs,
                datasetIndex: -1,
                dataIndex: -1
            };

            if (this.chart) {
                this.chart.update('none');
            }

            return;
        }

        const stateValue = Number(currentValue);

        if (!Number.isInteger(stateValue) || stateValue < 0 || stateValue >= this.ganttChartData.length) {
            if (this.chart) {
                this.chart.update('none');
            }

            return;
        }

        // [CUSTOM] Start a new interval when recovering from No Data
        if (!laneState || laneState.datasetIndex < 0 || laneState.dataIndex < 0) {
            const laneLabel = this.sourceMap[sigid]?.label ?? sigid;
            const dataIndex = this.ganttChartData[stateValue].data.length;

            this.ganttChartData[stateValue].data.push({
                x: [timestampMs, timestampMs],
                y: laneLabel
            });

            // [CUSTOM] Store only live state changes instead of every live sample
            if (!history || history.length === 0 || String(history[history.length - 1].value) !== currentValue) {
                if (!this.historyChanges[sigid]) {
                    this.historyChanges[sigid] = [];
                }

                this.historyChanges[sigid].push({
                    dt: timestampMs,
                    value: currentValue
                });
            }

            this.laneStates[sigid] = {
                currentState: currentValue,
                currentStart: timestampMs,
                currentEnd: timestampMs,
                datasetIndex: stateValue,
                dataIndex: dataIndex
            };

            if (this.chart) {
                this.chart.update('none');
            }

            return;
        }

        // [CUSTOM] Update only the active Gantt interval instead of rebuilding all datasets
        const activeDataset = this.ganttChartData[laneState.datasetIndex];
        const activePoint = activeDataset?.data?.[laneState.dataIndex];

        if (!activePoint) {
            if (this.chart) {
                this.chart.update('none');
            }

            return;
        }

        if (String(laneState.currentState) === currentValue) {
            // [CUSTOM] Extend only the current interval when the state has not changed
            activePoint.x[1] = timestampMs;
            laneState.currentEnd = timestampMs;
        } else {
            // [CUSTOM] Close the previous interval at the exact state change timestamp
            activePoint.x[1] = timestampMs;
            laneState.currentEnd = timestampMs;

            // [CUSTOM] Store only live state changes instead of every live sample
            if (!history || history.length === 0 || String(history[history.length - 1].value) !== currentValue) {
                if (!this.historyChanges[sigid]) {
                    this.historyChanges[sigid] = [];
                }

                this.historyChanges[sigid].push({
                    dt: timestampMs,
                    value: currentValue
                });
            }

            const laneLabel = this.sourceMap[sigid]?.label ?? sigid;
            const dataIndex = this.ganttChartData[stateValue].data.length;

            // [CUSTOM] Append only one new interval for the new state
            this.ganttChartData[stateValue].data.push({
                x: [timestampMs, timestampMs],
                y: laneLabel
            });

            // [CUSTOM] Cache the new active interval position for the next O(1) update
            this.laneStates[sigid] = {
                currentState: currentValue,
                currentStart: timestampMs,
                currentEnd: timestampMs,
                datasetIndex: stateValue,
                dataIndex: dataIndex
            };
        }

        const chart = this.chart?.chart as any;

        if (chart && this.xAxisMode === 'rolling') {
            chart.options.scales.x.min = this.ganttChartOptions.scales.x.min;
            chart.options.scales.x.max = this.ganttChartOptions.scales.x.max;
        }

        if (this.chart) {
            this.chart.update('none');
        }
    }
    
    isOffline() {
        // return this.ganttChartOptions.offline;
        // [CUSTOM] Gantt combines DAQ history with the current live Tag value
        return false;
    }

    public static DefaultOptions() {
        // [CUSTOM] Default Gantt window is today 00:00 to next day 00:00
        const rangeFromDate = new Date();
        rangeFromDate.setHours(0, 0, 0, 0);

        const rangeToDate = new Date(rangeFromDate);
        rangeToDate.setDate(rangeToDate.getDate() + 1);

        const toLocalDateTime = (date: Date) => {
            const offset = date.getTimezoneOffset() * 60000;
            return new Date(date.getTime() - offset).toISOString().slice(0, 16);
        };

        return <GraphOptions>{
            type: 'bar',
            theme: GraphThemeType.light,
            offline: false,
            decimals: 0,
            // [CUSTOM] Gantt time range settings
            rangeMode: 'rolling',
            rangeFrom: toLocalDateTime(rangeFromDate),
            rangeTo: toLocalDateTime(rangeToDate),
            // [CUSTOM] Gantt No Data timeout in seconds
            noDataIntervalSec: 90,
            responsive: true,
            // [CUSTOM] Gantt state settings
            stateCount: 4,
            stateColors: [
                '#6B7280',
                '#16A34A',
                '#F59E0B',
                '#DC2626',
                '#2563EB',
                '#9333EA',
                '#0891B2',
                '#DB2777',
                '#65A30D',
                '#EA580C',
                '#4F46E5',
                '#0D9488',
                '#CA8A04',
                '#7C3AED',
                '#0284C7',
                '#BE123C'
            ],
            stateNames: [
                'State 0',
                'State 1',
                'State 2',
                'State 3',
                'State 4',
                'State 5',
                'State 6',
                'State 7',
                'State 8',
                'State 9',
                'State 10',
                'State 11',
                'State 12',
                'State 13',
                'State 14',
                'State 15'
            ],
            maintainAspectRatio: false,
            // [CUSTOM] Disable animation for realtime Gantt updates
            animation: false,

            // [CUSTOM] Horizontal bars are used as the base of the Gantt chart
            indexAxis: 'y',

            // [CUSTOM] GraphPropertyComponent expects these common graph properties
            gridLinesShow: true,
            gridLinesColor: 'rgba(0, 0, 0, 0.2)',
            borderWidth: 0,

            scales: {
                x: {
                    display: true,
                    type: 'linear',
                    min: new Date('2026-10-25T08:00:00').getTime(),
                    max: new Date('2026-10-25T15:00:00').getTime(),
                    ticks: {
                        stepSize: 60 * 60 * 1000,
                        font: {
                            size: 12
                        },
                        // [CUSTOM] Display epoch milliseconds as time without a Chart.js date adapter
                        callback: (value) => {
                            const date = new Date(Number(value));
                            return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        }
                    },
                    grid: {
                        color: 'rgba(0, 0, 0, 0.2)',
                        display: true
                    }
                },
                y: {
                    display: true,
                    ticks: {
                        stepSize: 20,
                        font: {
                            size: 12
                        }
                    },
                    grid: {
                        color: 'rgba(0, 0, 0, 0.2)',
                        display: true
                    }
                }
            },

            plugins: {
                title: {
                    display: true,
                    text: 'Gantt',
                    font: {
                        size: 12
                    }
                },
                tooltip: {
                    enabled: true,
                    intersect: false
                },
                legend: {
                    display: true,
                    position: 'top',
                    align: 'center',
                    labels: {
                        font: {
                            size: 12
                        },
                        color: ''
                    }
                },
                datalabels: {
                    display: false,
                    anchor: 'end',
                    align: 'end',
                    font: {
                        size: 12
                    }
                }
            },

            panel: {
                height: 240,
                width: 380
            }
        };
    }
}