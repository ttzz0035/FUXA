// server/runtime/devices/opentelemetry/index.js
// OpenTelemetry Device integration for FUXA.

const http = require('http');
const https = require('https');

const { context, SeverityNumber, SpanStatusCode, trace } = require('@opentelemetry/api');
const { LoggerProvider, BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const {
    TracerProvider,
    BatchSpanProcessor,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
} = require('@opentelemetry/sdk-trace');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { ProtobufLogsSerializer } = require('@opentelemetry/otlp-transformer');


/**
 * OpenTelemetry Device instance.
 * Each FUXA Device owns its own endpoint, providers and connection state.
 */
function OpenTelemetryDevice(data, logger, events, manager) {
    this.data = data;
    this.logger = logger;
    this.events = events;
    this.manager = manager;

    let lastStatus = 'connect-off';

    /**
     * Create an OpenTelemetry connection error.
     */
    const createConnectionError = function (message, code) {
        const error = new Error(message);
        error.name = 'OpenTelemetryConnectionError';

        if (code) {
            error.code = code;
        }

        return error;
    };

    /**
     * Create an OpenTelemetry script error.
     */
    const createScriptError = function (message) {
        const error = new Error(message);
        error.name = 'OpenTelemetryScriptError';
        return error;
    };

    /**
     * Emit the OpenTelemetry Device connection status.
     */
    const emitStatus = function (status) {
        lastStatus = status;
        events.emit('device-status:changed', { id: data.id, status: status });
    };

    /**
     * Check whether the OpenTelemetry Collector endpoint is reachable.
     * Any HTTP response proves that the configured host and port are reachable.
     * Validate the actual OTLP/HTTP Logs endpoint before marking the Device as connected.
     * A successful check also requires a valid OTLP/HTTP Logs response.
     */
    const checkCollector = function (endpoint) {
        return new Promise(function (resolve, reject) {
            try {
                const url = new URL(endpoint);

                if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                    reject(createConnectionError(`Unsupported Collector protocol: ${url.protocol}`));
                    return;
                }

                const basePath = url.pathname.replace(/\/+$/, '');
                url.pathname = `${basePath}/v1/logs`;

                const client = url.protocol === 'https:' ? https : http;

                const req = client.request({
                    protocol: url.protocol,
                    hostname: url.hostname,
                    port: url.port,
                    path: `${url.pathname}${url.search}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-protobuf',
                        'Content-Length': 0,
                    },
                    timeout: 3000,
                }, function (res) {
                    const chunks = [];

                    res.on('data', function (chunk) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    });

                    res.on('end', function () {
                        const contentType = res.headers['content-type'] || '';

                        if (res.statusCode !== 200) {
                            reject(createConnectionError(`Collector returned HTTP ${res.statusCode}`));
                            return;
                        }

                        if (!contentType.includes('application/x-protobuf')) {
                            reject(createConnectionError(`Collector returned invalid content type: ${contentType || 'unknown content-type'}`));
                            return;
                        }

                        try {
                            const body = Buffer.concat(chunks);

                            // Decode the response as an OTLP ExportLogsServiceResponse.
                            ProtobufLogsSerializer.deserializeResponse(body);

                            resolve(true);
                        } catch (err) {
                            reject(createConnectionError(`Invalid OTLP Logs response: ${err.message}`, err.code));
                        }
                    });

                    res.on('error', function (err) {
                        reject(createConnectionError(`Collector response failed: ${err.code || err.message}`, err.code));
                    });
                });

                req.on('timeout', function () {
                    req.destroy(createConnectionError('Collector connection timeout', 'ETIMEDOUT'));
                });

                req.on('error', function (err) {
                    if (err.name === 'OpenTelemetryConnectionError') {
                        reject(err);
                        return;
                    }

                    reject(createConnectionError(`Collector connection failed: ${err.code || err.message}`, err.code));
                });

                req.end();
            } catch (err) {
                if (err.name === 'OpenTelemetryConnectionError') {
                    reject(err);
                    return;
                }

                reject(createConnectionError(`Collector configuration failed: ${err.message}`, err.code));
            }
        });
    };

    this.initialized = false;
    this.connected = false;
    this.loggerProvider = null;
    this.tracerProvider = null;
    this.otelLogger = null;
    this.tracer = null;
    this.contextManager = null;
    this.lastRead = 0;
    this.activeSpans = new Map();
    // Keep the user-configured sampling percentage for OpenTelemetry signals.
    this.samplingPercent = 100;

    // Sequence used only to provide a stable sampling input for standalone LogRecords.
    this.logSamplingSequence = 0;

    /**
     * Write an OpenTelemetry log event from a FUXA Tag.
     */
    const setLogValue = async (key, value) => {
        // Map the fixed OpenTelemetry Log Tags to OpenTelemetry severity values.
        const severityMap = {
            logs_trace: [SeverityNumber.TRACE, 'TRACE'],
            logs_debug: [SeverityNumber.DEBUG, 'DEBUG'],
            logs_info: [SeverityNumber.INFO, 'INFO'],
            logs_warn: [SeverityNumber.WARN, 'WARN'],
            logs_error: [SeverityNumber.ERROR, 'ERROR'],
            logs_fatal: [SeverityNumber.FATAL, 'FATAL'],
        };

        if (!severityMap[key]) {
            throw createScriptError(`Unsupported OpenTelemetry Log Tag: ${key}`);
        }

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw createScriptError('OpenTelemetry Log value must be an object');
        }

        if (typeof value.body !== 'string' || !value.body.length) {
            throw createScriptError('OpenTelemetry log body is required');
        }

        if (
            value.attributes !== undefined &&
            (
                typeof value.attributes !== 'object' ||
                value.attributes === null ||
                Array.isArray(value.attributes)
            )
        ) {
            throw createScriptError('OpenTelemetry log attributes must be an object');
        }

        // Reject writes while the OpenTelemetry Device is disconnected.
        if (!this.initialized || !this.otelLogger) {
            throw createConnectionError('OpenTelemetry Device is not connected');
        }

        // Resolve the OpenTelemetry severity from the fixed Log Tag.
        const [severityNumber, severityText] = severityMap[key];

        // Provide the Collector with the Device sampling percentage.
        // The Collector performs the actual sampling decision.
        this.logSamplingSequence += 1;

        this.otelLogger.emit({
            severityNumber,
            severityText,
            body: value.body,
            attributes: {
                ...(value.attributes || {}),
                'sampling.priority': this.samplingPercent,
                'fuxa.sampling.key': `${this.data.id}:${Date.now()}:${this.logSamplingSequence}`,
            },
        });

        this.logger.info(`[OpenTelemetry] log emitted: ${severityText} ${value.body}`);

        // Record the last successful write activity for the FUXA Device status.
        this.lastRead = Date.now();

        return true;
    };

    /**
     * Write an OpenTelemetry Trace operation from a FUXA Tag.
     */
    const setTraceValue = async (key, value) => {
        if (key !== 'traces_span') {
            throw createScriptError(`Unsupported OpenTelemetry Trace Tag: ${key}`);
        }

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw createScriptError('OpenTelemetry Trace value must be an object');
        }

        // Reject writes while the OpenTelemetry Device is disconnected.
        if (!this.initialized || !this.tracer) {
            throw createConnectionError('OpenTelemetry Device is not connected');
        }

        if (typeof value.action !== 'string' || !value.action.length) {
            throw createScriptError('OpenTelemetry Trace action is required');
        }

        if (typeof value.span_key !== 'string' || !value.span_key.length) {
            throw createScriptError('OpenTelemetry Trace span_key is required');
        }

        if (
            value.attributes !== undefined &&
            (
                typeof value.attributes !== 'object' ||
                value.attributes === null ||
                Array.isArray(value.attributes)
            )
        ) {
            throw createScriptError('OpenTelemetry Trace attributes must be an object');
        }

        if (value.action === 'start') {
            if (this.activeSpans.has(value.span_key)) {
                throw createScriptError(`OpenTelemetry Trace Span already exists: ${value.span_key}`);
            }

            let parentContext = context.active();

            if (value.parent_span_key) {
                const parentSpan = this.activeSpans.get(value.parent_span_key);

                if (!parentSpan) {
                    throw createScriptError(`OpenTelemetry parent Span not found: ${value.parent_span_key}`);
                }

                parentContext = trace.setSpan(parentContext, parentSpan);
            }

            const span = this.tracer.startSpan(
                value.name || value.span_key,
                {
                    attributes: value.attributes || {},
                },
                parentContext
            );

            this.activeSpans.set(value.span_key, span);
            this.lastRead = Date.now();

            this.logger.info(`[OpenTelemetry] span started: ${value.name || value.span_key}`);

            return true;
        }

        if (value.action === 'end') {
            const span = this.activeSpans.get(value.span_key);

            if (!span) {
                throw createScriptError(`OpenTelemetry Trace Span not found: ${value.span_key}`);
            }

            if (value.attributes) {
                span.setAttributes(value.attributes);
            }

            if (value.status === 'error') {
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: value.attributes?.error_message || 'Error',
                });
            } else {
                span.setStatus({
                    code: SpanStatusCode.OK,
                });
            }

            span.end();

            this.activeSpans.delete(value.span_key);
            this.lastRead = Date.now();

            this.logger.info(`[OpenTelemetry] span ended: ${value.span_key}`);

            return true;
        }

        throw createScriptError(`Unsupported OpenTelemetry Trace action: ${value.action}`);
    };

    /**
     * Write an OpenTelemetry Metric operation from a FUXA Tag.
     */
    const setMetricValue = async (key, value) => {
        throw createScriptError(`Unsupported OpenTelemetry Metric Tag: ${key}`);
    };

    /**
     * Write an OpenTelemetry value from a FUXA Tag.
     */
    this.setValue = async function (id, value) {
        // FUXA passes the Tag GUID to the Device.
        // Resolve the actual OpenTelemetry virtual Tag from the Device Tag dictionary.
        const tag = this.data?.tags?.[id];

        if (!tag) {
            throw createScriptError(`OpenTelemetry Tag not found: ${id}`);
        }

        // The OpenTelemetry operation is represented by the fixed Tag address.
        // Fall back to the Tag name so imported/legacy configurations can still be resolved.
        const key = tag.address || tag.name;

        if (key.startsWith('logs_')) {
            return setLogValue(key, value);
        }

        if (key.startsWith('traces_')) {
            return setTraceValue(key, value);
        }

        if (key.startsWith('metrics_')) {
            return setMetricValue(key, value);
        }

        throw createScriptError(`Unsupported OpenTelemetry Tag: ${key}`);
    };

    /**
     * Load OpenTelemetry Device settings and FUXA Tags.
     */
    this.load = function (data) {
        // Keep the complete Device configuration because FUXA routes writes by Tag ID.
        this.data = data;

        // Ensure the Tag dictionary always exists for Tag lookup.
        this.data.tags = this.data.tags || {};

        // OpenTelemetry exposes a fixed set of virtual Tags.
        // Create only missing Tags so existing Tag settings are preserved.
        [
            'logs_trace',
            'logs_debug',
            'logs_info',
            'logs_warn',
            'logs_error',
            'logs_fatal',
            'traces_span',
            'metrics_counter',
            'metrics_updowncounter',
            'metrics_histogram',
            'metrics_gauge',
        ].forEach(name => {
            const exists = Object.values(this.data.tags).some(tag => tag.name === name || tag.address === name);

            if (!exists) {
                const id = `t_${this.data.id}_${name}`;

                this.data.tags[id] = {
                    id,
                    name,
                    label: name,
                    type: 'object',
                    address: name,
                    memaddress: '',
                    divisor: 1,
                    format: null,
                    options: null,
                    init: '',
                    daq: {
                        enabled: false,
                        changed: false,
                        interval: 60,
                        restored: false,
                    },
                };
            }
        });

        return Promise.resolve();
    };

    /**
     * Connect OpenTelemetry Device.
     */
    this.connect = async function () {
        // Read the Collector endpoint from the Device settings.
        // Read OpenTelemetry connection settings from the common FUXA Device property object.
        const endpoint = this.data.property?.endpoint;
        const serviceName = this.data.property?.serviceName || this.data.name;

        // Read and normalize the user-configured sampling percentage.
        this.samplingPercent = Math.min(100, Math.max(0, Number(this.data.property?.samplingPercent ?? 100)));
        const samplingRatio = this.samplingPercent / 100;


        // Collector endpoint is required because there is no default destination.
        if (!endpoint || typeof endpoint !== 'string') {
            this.connected = false;
            emitStatus('connect-error');
            throw createConnectionError('OpenTelemetry endpoint is required');
        }

        // Verify that the configured OpenTelemetry Collector is actually reachable.
        try {
            await checkCollector(endpoint);
        } catch (err) {
            this.connected = false;
            emitStatus('connect-error');
            throw err;
        }

        // Do not initialize the same OpenTelemetry Device instance more than once.
        if (this.initialized) {
            this.connected = true;
            this.lastRead = Date.now();
            emitStatus('connect-ok');
            return true;
        }

        try {
            // Create the OpenTelemetry Resource shared by logs and traces.
            const resource = resourceFromAttributes({
                'service.name': serviceName,
            });

            // Create the OTLP/HTTP exporter for logs.
            const logExporter = new OTLPLogExporter({
                url: `${endpoint}/v1/logs`,
            });

            // Create the LoggerProvider.
            // BatchLogRecordProcessor buffers LogRecords and sends them in batches.
            this.loggerProvider = new LoggerProvider({
                resource,
                processors: [
                    new BatchLogRecordProcessor({
                        exporter: logExporter,
                    }),
                ],
            });

            // Create the OTLP/HTTP exporter for traces.
            const traceExporter = new OTLPTraceExporter({
                url: `${endpoint}/v1/traces`,
            });

            // Create the TracerProvider.
            // BatchSpanProcessor buffers completed spans before transmission.
            this.tracerProvider = new TracerProvider({
                resource,

                // Apply the Device-level sampling percentage to complete traces.
                sampler: new ParentBasedSampler({
                    root: new TraceIdRatioBasedSampler(samplingRatio),
                }),
                
                spanProcessors: [
                    new BatchSpanProcessor({
                        exporter: traceExporter,
                    }),
                ],
            });

            // Create the logger and tracer owned by this FUXA Device instance.
            this.otelLogger = this.loggerProvider.getLogger('fuxa');
            this.tracer = this.tracerProvider.getTracer('fuxa');

            // Mark the Device as initialized and connected after providers are ready.
            this.initialized = true;
            this.connected = true;
            this.lastRead = Date.now();

            // Write the active Collector destination to the FUXA server log.
            this.logger.info(`[OpenTelemetry] '${this.data.name}' connected to ${endpoint}`);
            emitStatus('connect-ok');

            return true;
        } catch (err) {
            this.connected = false;
            emitStatus('connect-error');

            if (err.name === 'OpenTelemetryConnectionError') {
                throw err;
            }

            throw createConnectionError(`OpenTelemetry initialization failed: ${err.message}`, err.code);
        }
    };

    /**
     * Disconnect OpenTelemetry Device.
     */
    this.disconnect = async function () {
        if (!this.initialized) {
            this.connected = false;
            emitStatus('connect-off');
            return true;
        }

        await Promise.all([
            this.loggerProvider ? this.loggerProvider.forceFlush() : Promise.resolve(),
            this.tracerProvider ? this.tracerProvider.forceFlush() : Promise.resolve(),
        ]);

        await Promise.all([
            this.loggerProvider ? this.loggerProvider.shutdown() : Promise.resolve(),
            this.tracerProvider ? this.tracerProvider.shutdown() : Promise.resolve(),
        ]);

        this.loggerProvider = null;
        this.tracerProvider = null;
        this.otelLogger = null;
        this.tracer = null;
        this.initialized = false;
        this.connected = false;
        emitStatus('connect-off');

        return true;
    };

    /**
     * Return OpenTelemetry Device connection state.
     */
    this.isConnected = function () {
        return this.connected;
    };

    /**
     * Check the OpenTelemetry Collector connection while the Device is running.
     */
    this.polling = async function () {
        if (!this.connected) {
            return;
        }

        try {
            const endpoint = this.data.property?.endpoint;

            await checkCollector(endpoint);

            this.lastRead = Date.now();
            emitStatus('connect-ok');
        } catch (err) {
            this.connected = false;
            emitStatus('connect-error');
            this.logger.error(`[OpenTelemetry] '${this.data.name}' connection lost: ${err.name}: ${err.message}`);
        }
    };

    /**
     * Return last activity timestamp for FUXA Device state management.
     */
    this.lastReadTimestamp = function () {
        return this.lastRead;
    };

    /**
     * OpenTelemetry Device does not expose persistent Tag values.
     */
    this.getValues = function () {
        return {};
    };

    /**
     * OpenTelemetry Device does not expose persistent Tag values.
     */
    this.getValue = function (id) {
        return null;
    };

    /**
     * Return OpenTelemetry Device status.
     */
    this.getStatus = function () {
        return lastStatus;
    };

    /**
     * OpenTelemetry Device does not use DAQ storage.
     */
    this.bindAddDaq = function (fnc) {
    };

    /**
     * Return the fixed OpenTelemetry Tags through the standard FUXA dynamic Tag-loading interface.
     * Tags are created by load(), so this method only exposes the current Device Tags.
     */
    this.getTagsProperty = function () {
        // Reuse the Tags already created and maintained by load().
        const tags = Object.values(this.data?.tags || {}).map(tag => [tag]);

        return Promise.resolve({
            tags,
            newTagsCount: 0,
        });
    };

    /**
     * Return OpenTelemetry Tag property.
     * FUXA uses this lookup to resolve a Tag ID to this Device before setValue().
     */
    this.getTagProperty = function (id) {
        if (this.data?.tags?.[id]) {
            const tag = this.data.tags[id];

            return {
                id,
                name: tag.name,
                type: tag.type,
                format: tag.format,
                address: tag.address,
            };
        }

        return null;
    };
}


module.exports = {
    create: function (data, logger, events, manager) {
        return new OpenTelemetryDevice(data, logger, events, manager);
    }
};