const path = require("path");
const { Worker } = require("worker_threads");
const { EventEmitter } = require("events");
const { normalizeAlgo } = require("./algorithms.cjs");

function resolveWebSocketImpl() {
    if (typeof globalThis.WebSocket === "function") {
        return globalThis.WebSocket;
    }

    try {
        // Node versions without global WebSocket can use ws package.
        // eslint-disable-next-line global-require
        return require("ws");
    } catch (_) {
        throw new Error(
            "WebSocket is not available. Use Node 22+ or install ws: npm i ws"
        );
    }
}

const WebSocketImpl = resolveWebSocketImpl();

function toUtf8(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    return String(data);
}

function encodeTarget(target) {
    return Buffer.from(target, "utf8").toString("base64");
}

function normalizeSocketUrl(config) {
    const host = String(config.host || "").trim();
    if (!host) {
        throw new Error("Missing required config: host");
    }

    // If host is already a full ws:// or wss:// URL, use it directly.
    if (/^wss?:\/\//i.test(host)) {
        return host;
    }

    const proxy = String(config.proxy || "").trim();
    if (!proxy) {
        throw new Error("When host is not a full websocket URL, config.proxy is required.");
    }

    const port = Number(config.port);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error("Missing or invalid config.port");
    }

    const proxyBase = proxy.replace(/\/+$/, "");
    return `${proxyBase}/${encodeTarget(`${host}:${port}`)}`;
}

class CliMiner extends EventEmitter {
    constructor(config) {
        super();

        this.config = { ...config };
        this.algorithm = normalizeAlgo(this.config.algo || this.config.algorithm);
        const configuredClientVersion = this.config.clientVersion
            ?? this.config.version
            ?? this.config.subscribeVersion
            ?? this.config.minerVersion;
        this.clientVersion = String(configuredClientVersion || "webminer/1.0").trim() || "webminer/1.0";
        this.socketUrl = normalizeSocketUrl(this.config);
        this.socket = null;
        this.connected = false;
        this.running = false;
        this.reconnectTimer = null;
        const configuredMaxRetries = Number(
            this.config.reconnectMaxAttempts
            ?? this.config.maxReconnectAttempts
            ?? this.config.reconnectRetries
            ?? 3
        );
        this.reconnectMaxAttempts = Number.isFinite(configuredMaxRetries) && configuredMaxRetries >= 0
            ? Math.floor(configuredMaxRetries)
            : 3;
        const configuredReconnectDelayMs = Number(
            this.config.reconnectDelayMs
            ?? this.config.reconnectGraceMs
            ?? this.config.reconnectGracePeriodMs
            ?? (5 * 60 * 1000)
        );
        this.reconnectDelayMs = Number.isFinite(configuredReconnectDelayMs) && configuredReconnectDelayMs >= 0
            ? Math.floor(configuredReconnectDelayMs)
            : (5 * 60 * 1000);
        this.reconnectAttempts = 0;

        this.extraNonce1 = "";
        this.extraNonce2Size = 0;
        this.difficulty = 0.01;
        this.job = null;
        this.jobGeneration = 0;

        this.msgId = 1;
        this.pendingRequests = new Map();
        this.reuseWorkersOnDirtyJobs = this.config.reuseWorkersOnDirtyJobs !== false;

        const requestedThreads = Number(this.config.threads ?? this.config.workers ?? 1);
        this.threads = Number.isFinite(requestedThreads) && requestedThreads > 0
            ? Math.floor(requestedThreads)
            : 1;

        this.workerBridgePath = path.resolve(__dirname, "worker-bridge.cjs");
        this.workers = [];
        this.workerHashrates = [];
        this.estimatedHashrate = 0;
        this.benchmarkWorker = null;
        this.benchmarkTimer = null;
        this.benchmarkGeneration = 0;
        this.estimateHashrate = this.config.estimateHashrate !== false;
        const configuredEstimateDiff = Number(
            this.config.hashrateEstimateDiff
            ?? this.config.hashrateBenchmarkDiff
            ?? 1e-8
        );
        this.hashrateEstimateDiff = Number.isFinite(configuredEstimateDiff) && configuredEstimateDiff > 0
            ? configuredEstimateDiff
            : 1e-8;
        const configuredEstimateSamples = Number(
            this.config.hashrateEstimateSamples
            ?? this.config.hashrateBenchmarkSamples
            ?? 6
        );
        this.hashrateEstimateSamples = Number.isFinite(configuredEstimateSamples) && configuredEstimateSamples > 0
            ? Math.floor(configuredEstimateSamples)
            : 6;
        const configuredEstimateTimeoutMs = Number(
            this.config.hashrateEstimateTimeoutMs
            ?? this.config.hashrateBenchmarkTimeoutMs
            ?? 4000
        );
        this.hashrateEstimateTimeoutMs = Number.isFinite(configuredEstimateTimeoutMs) && configuredEstimateTimeoutMs > 0
            ? Math.floor(configuredEstimateTimeoutMs)
            : 4000;

        this.accepted = 0;
        this.rejected = 0;
        this.hashrate = 0;
    }

    setStatus(status) {
        this.status = status;
        this.emit("status", status);
    }

    getReportedHashrate() {
        if (!this.running || this.workers.length === 0) {
            return 0;
        }

        if (this.hashrate > 0) {
            return this.hashrate;
        }

        return this.estimatedHashrate;
    }

    emitReportedHashrate() {
        this.emit("hashrate", this.getReportedHashrate());
    }

    emitStats() {
        this.emit("stats", {
            hashrate: this.getReportedHashrate(),
            accepted: this.accepted,
            rejected: this.rejected
        });
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        this.accepted = 0;
        this.rejected = 0;
        this.hashrate = 0;
        this.estimatedHashrate = 0;
        this.workerHashrates = new Array(this.threads).fill(0);
        this.emitStats();
        this.connect();
    }

    stop() {
        this.running = false;
        this.connected = false;
        this.jobGeneration++;
        this.pendingRequests.clear();
        this.clearReconnectTimer();
        this.stopHashrateBenchmark();

        if (this.socket) {
            try {
                this.socket.close();
            } catch (_) {
                // Ignore close errors during shutdown.
            }
            this.socket = null;
        }

        this.terminateWorkers({ emitZero: true });
        this.setStatus("Stopped");
    }

    connect() {
        if (!this.running) return;
        this.setStatus("Connecting...");
        const socket = new WebSocketImpl(this.socketUrl);
        this.socket = socket;
        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.connected = true;
            this.reconnectAttempts = 0;
            this.setStatus("Connected, Authenticating...");
            this.emit("connect");
            this.startStratum();
        };

        socket.onmessage = (event) => {
            if (this.socket !== socket) return;
            this.handleSocketMessage(event.data);
        };

        socket.onerror = (event) => {
            if (this.socket !== socket) return;
            const err = event && event.error ? event.error : new Error("WebSocket error");
            this.setStatus("Error");
            this.emit("error", err);
        };

        socket.onclose = (event) => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.connected = false;
            this.pendingRequests.clear();
            this.stopHashrateBenchmark();
            this.terminateWorkers({ emitZero: true });
            if (this.running) {
                this.emit("close", event);
                this.scheduleReconnect();
            }
        };
    }

    clearReconnectTimer() {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    scheduleReconnect() {
        if (!this.running) return;
        this.clearReconnectTimer();

        if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
            this.setStatus("Disconnected (max reconnect attempts reached)");
            this.emit("reconnect_failed", {
                attempts: this.reconnectAttempts,
                maxAttempts: this.reconnectMaxAttempts
            });
            return;
        }

        const nextAttempt = this.reconnectAttempts + 1;
        const waitSeconds = Math.max(1, Math.round(this.reconnectDelayMs / 1000));
        this.setStatus(
            `Disconnected. Reconnecting in ${waitSeconds}s (${nextAttempt}/${this.reconnectMaxAttempts})`
        );
        this.emit("reconnect_scheduled", {
            attempt: nextAttempt,
            maxAttempts: this.reconnectMaxAttempts,
            delayMs: this.reconnectDelayMs
        });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.running) return;
            this.reconnectAttempts = nextAttempt;
            this.setStatus(`Reconnecting (${this.reconnectAttempts}/${this.reconnectMaxAttempts})...`);
            this.emit("reconnect_attempt", {
                attempt: this.reconnectAttempts,
                maxAttempts: this.reconnectMaxAttempts
            });
            this.connect();
        }, this.reconnectDelayMs);
    }

    handleSocketMessage(rawData) {
        const payload = toUtf8(rawData);
        const lines = payload.split("\n");
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                this.processStratumMessage(message);
            } catch (_) {
                // Ignore invalid chunks from proxy.
            }
        }
    }

    processStratumMessage(msg) {
        const pendingType = msg && msg.id != null ? this.pendingRequests.get(msg.id) : null;
        if (pendingType) {
            this.pendingRequests.delete(msg.id);

            if (pendingType === "submit") {
                const ok = msg.result === true && !msg.error;
                if (ok) {
                    this.accepted += 1;
                    this.emit("accepted", this.accepted);
                } else {
                    this.rejected += 1;
                    this.emit("rejected", this.rejected);
                }
                this.emitStats();
            }

            if (pendingType === "authorize" && (msg.result !== true || msg.error)) {
                this.emit("error", new Error("Worker authorization failed"));
            }
        }

        if (msg.id !== null && Array.isArray(msg.result) && msg.result.length >= 2 && typeof msg.result[1] === "string") {
            this.extraNonce1 = msg.result[1];
            this.extraNonce2Size = msg.result[2] || 4;
            this.emit("subscribe", {
                extraNonce1: this.extraNonce1,
                extraNonce2Size: this.extraNonce2Size
            });
            return;
        }

        if (msg.method === "mining.set_difficulty") {
            this.difficulty = msg.params?.[0] || this.difficulty;
            this.emit("difficulty", this.difficulty);
            return;
        }

        if (msg.method === "mining.notify") {
            const params = msg.params || [];
            this.job = {
                extraNonce1: this.extraNonce1,
                extraNonce2Size: this.extraNonce2Size || 4,
                miningDiff: this.difficulty || 0.01,
                jobId: params[0],
                prevhash: params[1],
                coinb1: params[2],
                coinb2: params[3],
                merkle_branch: params[4],
                version: params[5],
                nbits: params[6],
                ntime: params[7],
                clean_jobs: params[8],
                nonce: 0,
                arg: "0607"
            };

            this.setStatus("Mining");
            this.emit("job", this.job);
            this.notifyWorkers(this.job);
        }
    }

    sendJson(method, params, requestType = "generic") {
        if (!this.connected || !this.socket || this.socket.readyState !== WebSocketImpl.OPEN) return null;
        const id = this.msgId++;
        const message = {
            id,
            method,
            params
        };
        this.pendingRequests.set(id, requestType);
        this.socket.send(`${JSON.stringify(message)}\n`);
        return id;
    }

    startStratum() {
        this.sendJson("mining.subscribe", [this.clientVersion], "subscribe");
        setTimeout(() => {
            if (!this.running) return;
            this.sendJson("mining.authorize", [this.config.user, this.config.pass || "x"], "authorize");
        }, 700);
    }

    stopHashrateBenchmark() {
        this.benchmarkGeneration += 1;

        if (this.benchmarkTimer) {
            clearTimeout(this.benchmarkTimer);
            this.benchmarkTimer = null;
        }

        if (!this.benchmarkWorker) return;

        const worker = this.benchmarkWorker;
        this.benchmarkWorker = null;

        try {
            worker.terminate();
        } catch (_) {
            // Ignore termination errors during reconnect/shutdown.
        }
    }

    maybeStartHashrateBenchmark(job) {
        if (!this.estimateHashrate || !job || this.estimatedHashrate > 0 || this.benchmarkWorker) {
            return;
        }

        const benchmarkJob = {
            ...job,
            miningDiff: this.hashrateEstimateDiff
        };
        const worker = new Worker(this.workerBridgePath);
        const samples = [];
        const generation = ++this.benchmarkGeneration;
        let finished = false;

        const finish = () => {
            if (finished || generation !== this.benchmarkGeneration) return;
            finished = true;

            if (this.benchmarkTimer) {
                clearTimeout(this.benchmarkTimer);
                this.benchmarkTimer = null;
            }

            if (this.benchmarkWorker === worker) {
                this.benchmarkWorker = null;
            }

            try {
                worker.terminate();
            } catch (_) {
                // Ignore benchmark cleanup errors.
            }

            if (samples.length === 0) return;

            const averagePerThreadHashrate = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            const estimatedHashrate = averagePerThreadHashrate * this.threads;
            if (!(estimatedHashrate > 0)) return;

            this.estimatedHashrate = estimatedHashrate;
            if (this.hashrate <= 0 && this.workers.length > 0) {
                this.emitReportedHashrate();
                this.emitStats();
            }
        };

        this.benchmarkWorker = worker;
        this.benchmarkTimer = setTimeout(finish, this.hashrateEstimateTimeoutMs);

        worker.on("message", (data) => {
            if (generation !== this.benchmarkGeneration || !this.running) return;
            if (!data || typeof data !== "object") return;

            if ((data.type === "submit" || data.type === "share") && data.hashrate != null) {
                const sample = Number(data.hashrate) * 1000;
                if (sample > 0) {
                    samples.push(sample);
                }

                if (samples.length >= this.hashrateEstimateSamples) {
                    finish();
                }
            }
        });

        worker.on("error", (err) => {
            if (generation !== this.benchmarkGeneration) return;
            this.emit("error", err);
            finish();
        });

        worker.postMessage({
            algo: this.algorithm,
            work: benchmarkJob
        });
    }

    terminateWorkers(options = {}) {
        const emitZero = options.emitZero !== false;
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];

        if (emitZero) {
            this.workerHashrates = new Array(this.threads).fill(0);
            this.hashrate = 0;
            this.emitReportedHashrate();
            this.emitStats();
        }
    }

    notifyWorkers(job) {
        const hasWorkerPool = this.workers.length === this.threads;
        const shouldReuseCurrentWorkers = this.reuseWorkersOnDirtyJobs
            && hasWorkerPool
            && job
            && job.clean_jobs === false;

        if (shouldReuseCurrentWorkers) {
            // Stratum clean_jobs=false means previous jobs are still valid. Keep workers
            // alive to avoid respawn churn and hashrate dips on every notify.
            this.emit("job_reused", job.jobId);
            return;
        }

        this.terminateWorkers({ emitZero: false });
        const generation = ++this.jobGeneration;

        const baselineSource = this.hashrate > 0 ? this.hashrate : this.estimatedHashrate;
        const baseline = baselineSource > 0 ? (baselineSource / Math.max(this.threads, 1)) : 0;
        this.workerHashrates = new Array(this.threads).fill(baseline);

        for (let index = 0; index < this.threads; index++) {
            this.createWorker(index, job, generation);
        }

        this.maybeStartHashrateBenchmark(job);
    }

    createWorker(index, job, generation) {
        const worker = new Worker(this.workerBridgePath);
        this.workers.push(worker);

        worker.on("message", (data) => {
            if (generation !== this.jobGeneration || !this.running) return;
            this.handleWorkerMessage(index, data);
        });

        worker.on("error", (err) => {
            this.emit("error", err);
        });

        worker.postMessage({
            algo: this.algorithm,
            work: job
        });
    }

    handleWorkerMessage(workerIndex, data) {
        if (!data || typeof data !== "object") return;

        if (data.type === "hashrate") {
            const value = Number(data.value) || 0;
            this.workerHashrates[workerIndex] = value * 1000;
            this.hashrate = this.workerHashrates.reduce((sum, current) => sum + current, 0);
            this.emitReportedHashrate();
            this.emitStats();
            return;
        }

        if (data.type === "submit" || data.type === "share") {
            if (data.hashrate != null) {
                // The extracted worker often reports hashrate with submit events.
                const workerHashrate = Number(data.hashrate) || 0;
                this.workerHashrates[workerIndex] = workerHashrate * 1000;
                this.hashrate = this.workerHashrates.reduce((sum, current) => sum + current, 0);
                this.emitReportedHashrate();
                this.emitStats();
            }

            const share = data.data || data.share;
            if (share && share.job_id && share.extranonce2 && share.ntime && share.nonce) {
                this.sendJson("mining.submit", [
                    this.config.user,
                    share.job_id,
                    share.extranonce2,
                    share.ntime,
                    share.nonce
                ], "submit");
                this.emit("share_submitted", share);
            }
            return;
        }

        if (data.type === "log" && data.message) {
            this.emit("worker_log", String(data.message));
        }
    }
}

module.exports = CliMiner;
