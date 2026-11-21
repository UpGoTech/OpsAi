import assert from "node:assert/strict";
import test from "node:test";

import { SessionStream } from "../src/api/stream.js";

async function collect(stream, count) {
	const events = [];
	for await (const event of stream) {
		events.push(event);
		if (events.length >= count) break;
	}
	return events;
}

test("poll stream yields durable rows after the cursor and reports run_ended once", async () => {
	const fetches = [];
	let tick = 0;
	const stream = new SessionStream({
		session: "s1",
		since: 2,
		pollInterval: 20,
		fetchEntries: async (cursor) => {
			fetches.push(cursor);
			tick += 1;
			if (tick === 1) {
				return {
					entries: [
						{ type: "user_message", seq: 3 },
						{ type: "assistant_message", seq: 4 },
						{ type: "run_ended", seq: 5, reason: "done" },
					],
				};
			}
			return { entries: [] };
		},
		onTerminal: (seq) => {
			assert.equal(seq, 5);
		},
	});

	const events = await collect(stream, 3);
	stream.close();
	assert.deepEqual(
		events.map((e) => e.seq),
		[3, 4, 5]
	);
	assert.equal(fetches[0], 2);
});

test("later polls surface new rows past the cursor", async () => {
	let tick = 0;
	const stream = new SessionStream({
		session: "s1",
		since: 0,
		pollInterval: 15,
		fetchEntries: async (cursor) => {
			tick += 1;
			if (tick === 1) return { entries: [{ type: "user_message", seq: 1 }] };
			if (tick === 2) return { entries: [{ type: "assistant_message", seq: 2 }] };
			return { entries: [] };
		},
	});

	const events = await collect(stream, 2);
	stream.close();
	assert.deepEqual(
		events.map((e) => [e.type, e.seq]),
		[
			["user_message", 1],
			["assistant_message", 2],
		]
	);
});

test("closing the stream stops the iterator", async () => {
	const stream = new SessionStream({
		session: "s1",
		since: 0,
		pollInterval: 50,
		fetchEntries: async () => ({ entries: [] }),
	});
	const iterator = stream[Symbol.asyncIterator]();
	const pending = iterator.next();
	stream.close();
	assert.equal((await pending).done, true);
});
