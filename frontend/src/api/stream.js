import { __ } from "@opsai/ui-core/translate.js";

const DEFAULT_POLL_MS = 900;

// Hermes has no Flow relay. Live updates are polling: fetch entries since the cursor on an
// interval (and once immediately). Durable run_ended rows report through `onTerminal` once.
export class SessionStream {
	constructor({
		socket = null,
		session,
		since = 0,
		fetchEntries,
		present = (event) => event,
		onTerminal = null,
		pollInterval = DEFAULT_POLL_MS,
	}) {
		this.socket = socket;
		this.session = session;
		this.cursor = since;
		this.fetchEntries = fetchEntries;
		this.present = present;
		this.onTerminal = onTerminal;
		this.pollInterval = pollInterval;
		this.closed = false;
		this.synced = new Set();
		this._timer = null;
		this.waiting = null;
		this.queue = [];
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this.wake();
	}

	push(item) {
		this.queue.push(item);
		this.wake();
	}

	wake() {
		const resolve = this.waiting;
		if (!resolve) return;
		this.waiting = null;
		resolve(this.queue.length ? this.queue.shift() : null);
	}

	next() {
		if (this.queue.length) return Promise.resolve(this.queue.shift());
		if (this.closed) return Promise.resolve(null);
		return new Promise((resolve) => (this.waiting = resolve));
	}

	schedulePoll() {
		if (this.closed || this._timer) return;
		this._timer = setTimeout(() => {
			this._timer = null;
			if (!this.closed) this.push({ kind: "poll" });
		}, this.pollInterval);
	}

	async *[Symbol.asyncIterator]() {
		try {
			yield* this.resnapshot();
			this.schedulePoll();
			while (!this.closed) {
				const item = await this.next();
				if (item === null) return;
				if (item.kind === "poll") {
					yield* this.resnapshot();
					this.schedulePoll();
				}
			}
		} finally {
			this.close();
		}
	}

	async *resnapshot() {
		const data = await this.fetchEntries(this.cursor);
		if (this.closed) return;
		const rows = (data.entries ?? [])
			.filter((row) => typeof row.seq === "number" && row.seq > this.cursor)
			.sort((a, b) => a.seq - b.seq);
		for (const row of rows) {
			this.cursor = row.seq;
			this.terminal(row);
			yield row;
		}
		if (data.preview?.length) yield { type: "preview_replay_started" };
		for (const event of data.preview ?? []) yield event;
	}

	terminal(event) {
		if (event.type !== "run_ended" || event.subagent_id || this.synced.has(event.seq)) return;
		this.synced.add(event.seq);
		this.onTerminal?.(event.seq, event);
	}
}
