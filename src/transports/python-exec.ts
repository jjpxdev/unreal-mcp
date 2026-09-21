import { RemoteExecution, RemoteExecutionConfig } from "unreal-remote-execution";
import { PythonExecutionError, TimeoutError, UnrealMcpError } from "../utils/errors.js";

export interface PythonExecConfig {
	host: string;
	port: number;
	timeout: number;
}

/**
 * Client for Unreal Engine's built-in Python Remote Execution protocol.
 * Uses the `unreal-remote-execution` package which implements the full protocol:
 * - UDP multicast discovery on 239.0.0.1:6766
 * - Inverted TCP model (we are the server, UE connects to us)
 * - Proper message framing with magic "ue_py" and UUIDs
 *
 * Requires "Python Editor Script Plugin" enabled in UE with
 * "Enable Remote Execution" checked in its settings.
 */
export class PythonExecClient {
	private remote: RemoteExecution;
	private timeout: number;
	private _started = false;
	private _commandReady = false;
	private _discoveryFailed = false;
	private _lastDiscoveryAttempt = 0;

	constructor(config: PythonExecConfig) {
		const remoteConfig = new RemoteExecutionConfig(
			0, // multicastTTL: local host only
			["239.0.0.1", 6766], // multicastGroupEndpoint (UE default)
			// multicastBindAddress: was hardcoded "0.0.0.0", which lets the OS
			// pick the default outbound interface for the multicast send -- on
			// Windows that's typically the real NIC, not loopback. When UE's
			// own RemoteExecutionMulticastBindAddress is 127.0.0.1 (the
			// recommended, hardened setting -- see README Security section),
			// its multicast group membership is scoped to that interface only,
			// so a ping arriving via any other interface is silently dropped:
			// discovery fails with no error on either side. Using config.host
			// here (matches commandEndpoint below, always 127.0.0.1 in this
			// codebase) forces the client to send via the same interface the
			// editor is actually listening on. Confirmed via a raw UDP test:
			// binding/sending via "0.0.0.0" got no reply; forcing "127.0.0.1"
			// got an immediate, valid pong from the editor.
			config.host,
			[config.host, config.port], // commandEndpoint
		);
		this.remote = new RemoteExecution(remoteConfig);
		this.timeout = config.timeout;
	}

	async isAvailable(): Promise<boolean> {
		try {
			// If discovery failed recently, skip the slow 5s wait and return false
			// Retry every 30 seconds in case the user enables Remote Execution
			if (this._discoveryFailed && Date.now() - this._lastDiscoveryAttempt < 30_000) {
				return false;
			}
			if (!this._started) {
				await this.ensureStarted();
			}
			const found = this.remote.remoteNodes.length > 0;
			if (!found) {
				this._discoveryFailed = true;
				this._lastDiscoveryAttempt = Date.now();
			} else {
				this._discoveryFailed = false;
			}
			return found;
		} catch {
			this._discoveryFailed = true;
			this._lastDiscoveryAttempt = Date.now();
			return false;
		}
	}

	private async ensureStarted(): Promise<void> {
		if (this._started) return;

		try {
			await this.remote.start();
			this._started = true;

			// remote.start() only opens the broadcast socket -- it does NOT
			// send a discovery ping (that only happens via
			// startSearchingForNodes()/getFirstRemoteNode() in the
			// unreal-remote-execution library). Without this call, the wait
			// loop below polls remoteNodes forever without anything ever
			// populating it: confirmed via direct testing, the previous
			// version of this method never actually asked the editor
			// anything. startSearchingForNodes(interval) pings on that same
			// cadence while we wait.
			this.remote.startSearchingForNodes(500);

			// Wait for UE node discovery via UDP multicast
			await new Promise<void>((resolve) => {
				const maxWait = 5000;
				const interval = 500;
				let elapsed = 0;

				const check = () => {
					if (this.remote.remoteNodes.length > 0 || elapsed >= maxWait) {
						resolve();
						return;
					}
					elapsed += interval;
					setTimeout(check, interval);
				};
				check();
			});

			// Deliberately NOT calling stopSearchingForNodes() here: despite
			// its name, it does `this.nodes = {}` internally in the
			// unreal-remote-execution library -- calling it immediately wipes
			// the node we just found, so isAvailable()'s very next check
			// (`remote.remoteNodes.length > 0`) would always see 0 and
			// report unavailable even on a successful discovery. Confirmed
			// by direct trace: remoteNodes.length was 1 at the moment this
			// resolved, then 0 immediately after adding a stop call here.
			// Leaving the periodic ping running is a minor, harmless amount
			// of local network chatter; openCommandConnection() already
			// stops searching on its own once a real connection opens.
		} catch (err) {
			this._started = false;
			throw new UnrealMcpError(
				`Failed to start Python Remote Execution: ${err}`,
				"PYTHON_CONNECTION_FAILED",
			);
		}
	}

	private async ensureCommandConnection(): Promise<void> {
		if (this._commandReady && this.remote.hasCommandConnection()) return;

		await this.ensureStarted();

		const nodes = this.remote.remoteNodes;
		if (nodes.length === 0) {
			throw new UnrealMcpError(
				"No Unreal Editor nodes found. Make sure the editor is running with Python Remote Execution enabled.",
				"NO_UE_NODES",
			);
		}

		await this.remote.openCommandConnection(nodes[0]);
		this._commandReady = true;
	}

	/**
	 * Execute Python code in the Unreal Editor's Python environment.
	 * Returns the captured stdout output.
	 */
	async execute(pythonCode: string): Promise<string> {
		await this.ensureCommandConnection();

		try {
			const result = await Promise.race([
				this.remote.runCommand(pythonCode, true),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new TimeoutError("Python execution", this.timeout)),
						this.timeout,
					),
				),
			]);

			if (!result.success) {
				const errorOutput = result.output
					.filter((o: { type: string }) => o.type === "Error")
					.map((o: { output: string }) => o.output)
					.join("\n");
				const errorMsg = errorOutput || result.result || "Unknown Python execution error";
				throw new PythonExecutionError(errorMsg, JSON.stringify(result));
			}

			// Collect stdout (Info-type output)
			const stdout = result.output
				.filter((o: { type: string }) => o.type === "Info")
				.map((o: { output: string }) => o.output)
				.join("")
				.trim();

			return stdout || result.result || "";
		} catch (error) {
			if (error instanceof UnrealMcpError) throw error;
			// Connection may have dropped — reset and let next call reconnect
			this._commandReady = false;
			throw new PythonExecutionError(`Python execution failed: ${error}`, String(error));
		}
	}

	/**
	 * Execute a Python script (already rendered via template engine).
	 */
	async executeScript(renderedScript: string): Promise<string> {
		return this.execute(renderedScript);
	}

	async disconnect(): Promise<void> {
		if (this._commandReady) {
			try {
				this.remote.closeCommandConnection();
			} catch {
				// Ignore
			}
			this._commandReady = false;
		}
		if (this._started) {
			try {
				await this.remote.stop();
			} catch {
				// Ignore shutdown errors
			}
			this._started = false;
		}
	}
}
