import { test, expect } from "bun:test";
import { NotionApiError, NotionClient } from "./client";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch stand-in that records calls and replays queued JSON responses. */
function recorder(responses: unknown[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responses[calls.length - 1] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const schemaWith = (names: string[]) => ({
  properties: {
    "Account Status": {
      id: "biOx",
      name: "Account Status",
      type: "status",
      status: { options: names.map((name, i) => ({ id: `id${i}`, name, color: "default" })) },
    },
  },
});

test("addStatusOptions appends only the missing options and keeps the existing ones", async () => {
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"]), {}]);
  const client = new NotionClient("tok", impl);

  const added = await client.addStatusOptions("ds1", "Account Status", [
    "Live",
    "All ads rejected",
    "Ad Account Blocked",
  ]);

  expect(added).toEqual(["All ads rejected", "Ad Account Blocked"]);
  expect(calls[1].method).toBe("PATCH");
  const sent = calls[1].body as {
    properties: { "Account Status": { status: { options: { name: string }[] } } };
  };
  // Existing options are resent: the array REPLACES the list, so omitting one deletes it.
  expect(sent.properties["Account Status"].status.options.map((o) => o.name)).toEqual([
    "Live",
    "Paused",
    "All ads rejected",
    "Ad Account Blocked",
  ]);
});

test("addStatusOptions makes no write when every option already exists", async () => {
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"])]);
  const client = new NotionClient("tok", impl);

  const added = await client.addStatusOptions("ds1", "Account Status", ["Live", "Paused"]);

  expect(added).toEqual([]);
  expect(calls).toHaveLength(1); // read only, no PATCH
});

test("addStatusOptions matches option names case-insensitively", async () => {
  // Notion requires option names to be unique case-insensitively, so "live" is not addable
  // alongside "Live" — attempting it would 400.
  const { calls, impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  expect(await client.addStatusOptions("ds1", "Account Status", ["live"])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("addStatusOptions rejects a name containing a comma", async () => {
  // Commas are not valid in Notion option names; failing loudly beats a 400 from the API.
  const { impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["a,b"])).rejects.toThrow("comma");
});

test("addStatusOptions throws when the property is not a status property", async () => {
  const { impl } = recorder([
    { properties: { "Account Status": { id: "x", name: "Account Status", type: "select" } } },
  ]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["Live"])).rejects.toThrow(
    "status",
  );
});

test("addStatusOptions refuses to PATCH when the schema carries no options array", async () => {
  // The destructive branch. An options-less `status` object used to fall back to [], which would send
  // ONLY the requested names — and since the array REPLACES the option list, every existing option
  // (and every row's value in it) would be deleted from a board the whole team uses. A read that does
  // not show the current options is not a licence to replace them.
  const { calls, impl } = recorder([
    { properties: { "Account Status": { id: "x", name: "Account Status", type: "status" } } },
  ]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["Live"])).rejects.toThrow(
    "options",
  );
  expect(calls).toHaveLength(1); // read only — no PATCH may be issued
});

test("addStatusOptions refuses to PATCH when status.options is not an array", async () => {
  const { calls, impl } = recorder([
    {
      properties: {
        "Account Status": {
          id: "x",
          name: "Account Status",
          type: "status",
          status: { options: {} },
        },
      },
    },
  ]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["Live"])).rejects.toThrow(
    "options",
  );
  expect(calls).toHaveLength(1);
});

test("addStatusOptions rejects duplicate requested names instead of letting Notion 400", async () => {
  // Names are unique case-insensitively in Notion. Deduping only against EXISTING options let two
  // case-equal requested names through, and the PATCH would fail opaquely.
  const { calls, impl } = recorder([schemaWith(["Live"])]);
  const client = new NotionClient("tok", impl);

  await expect(
    client.addStatusOptions("ds1", "Account Status", ["Paused", "paused"]),
  ).rejects.toThrow("duplicate");
  expect(calls).toHaveLength(0); // rejected pre-flight, before the schema is even read
});

test("addStatusOptions resends existing options by id, not name alone", async () => {
  // A name-only entry leaves it to Notion whether to match the existing option or mint a same-named
  // twin under a fresh id. The second would orphan every row's stored value just as surely as
  // dropping the option would. The id came from the read, so pinning it is unambiguous.
  const { calls, impl } = recorder([schemaWith(["Live", "Paused"]), {}]);
  const client = new NotionClient("tok", impl);

  await client.addStatusOptions("ds1", "Account Status", ["All ads rejected"]);

  const sent = calls[1].body as {
    properties: { "Account Status": { status: { options: { id?: string; name: string }[] } } };
  };
  expect(sent.properties["Account Status"].status.options).toEqual([
    { id: "id0", name: "Live" },
    { id: "id1", name: "Paused" },
    { name: "All ads rejected" }, // no id yet — it does not exist on the board
  ]);
});

test("addStatusOptions refuses to PATCH when an option lacks a usable name", async () => {
  // Array.isArray is not enough: a malformed element would otherwise blow up mid-map with a raw
  // TypeError rather than the descriptive refusal.
  const { calls, impl } = recorder([
    {
      properties: {
        "Account Status": {
          id: "x",
          name: "Account Status",
          type: "status",
          status: { options: [{ id: "id0", name: "Live" }, { id: "id1" }] },
        },
      },
    },
  ]);
  const client = new NotionClient("tok", impl);

  await expect(client.addStatusOptions("ds1", "Account Status", ["Paused"])).rejects.toThrow(
    "refusing to PATCH",
  );
  expect(calls).toHaveLength(1);
});

test("createComment posts one rich_text item per chunk and returns the comment id", async () => {
  const { calls, impl } = recorder([{ object: "comment", id: "c123" }]);
  const client = new NotionClient("tok", impl);

  const id = await client.createComment("page-1", ["first", "second"]);

  expect(id).toBe("c123");
  expect(calls[0].url).toBe("https://api.notion.com/v1/comments");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toEqual({
    parent: { page_id: "page-1" },
    rich_text: [
      { type: "text", text: { content: "first" } },
      { type: "text", text: { content: "second" } },
    ],
  });
});

test("createComment rejects an empty body instead of posting a blank comment", async () => {
  const { calls, impl } = recorder([{}]);
  const client = new NotionClient("tok", impl);

  // The page id must be in the message: the worker posts many comments per run, so a bare
  // "empty comment" log line could not be correlated back to a campaign.
  await expect(client.createComment("page-1", [])).rejects.toThrow(/empty comment on page-1/);
  expect(calls).toHaveLength(0);
});

test("createComment returns null when the accepted response carries no usable id", async () => {
  // Accepted-but-unaddressable is NOT a failure: the comment IS on the client's card. It used to
  // throw, and the flush's catch retried it — up to five identical comments on a client's card, each
  // one followed by an alert claiming the write had failed. `""` is as unusable as absent, so a bare
  // `typeof` check must not let it through as a real id.
  for (const response of [{ object: "comment" }, { object: "comment", id: "" }]) {
    const { calls, impl } = recorder([response]);
    const client = new NotionClient("tok", impl);

    expect(await client.createComment("page-1", ["hi"])).toBeNull();
    expect(calls).toHaveLength(1); // it really did post; null is the OUTCOME, not a refusal
  }
});

test("a Notion rejection throws NotionApiError, and only 429/5xx are retryable", async () => {
  // The flush spends a prompt's retry budget on non-retryable statuses only, so this classification
  // is what stops one Notion outage permanently abandoning a whole backlog of answers.
  const failing = (status: number, body: unknown) =>
    new NotionClient(
      "tok",
      (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );

  const err = await failing(403, { message: "insufficient capabilities" })
    .createComment("page-1", ["hi"])
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NotionApiError);
  // The message format is unchanged from the plain Error this replaced.
  expect((err as NotionApiError).message).toBe("Notion 403: insufficient capabilities");
  expect((err as NotionApiError).retryable).toBe(false);

  for (const status of [429, 500, 502, 503]) {
    const e = await failing(status, { message: "later" })
      .createComment("page-1", ["hi"])
      .catch((x: unknown) => x);
    expect((e as NotionApiError).retryable).toBe(true);
  }
  for (const status of [400, 401, 404]) {
    const e = await failing(status, { message: "nope" })
      .createComment("page-1", ["hi"])
      .catch((x: unknown) => x);
    expect((e as NotionApiError).retryable).toBe(false);
  }
});

test("an unparseable error body still classifies by status instead of faulting", async () => {
  // A proxy's HTML 502 is exactly the retryable case, and `res.json()` throws on it. Reading the
  // status before the body is what keeps that a NotionApiError rather than a SyntaxError the flush
  // cannot classify.
  const client = new NotionClient(
    "tok",
    (async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch,
  );

  const err = (await client.createComment("page-1", ["hi"]).catch((e: unknown) => e)) as unknown;
  expect(err).toBeInstanceOf(NotionApiError);
  expect((err as NotionApiError).message).toBe("Notion 502: request failed");
  expect((err as NotionApiError).retryable).toBe(true);
});

test("listComments flattens rich_text and follows the cursor", async () => {
  const { calls, impl } = recorder([
    {
      results: [
        { id: "c1", rich_text: [{ plain_text: "Daily check-in " }, { plain_text: "part two" }] },
        { id: "c2", rich_text: [] },
      ],
      has_more: true,
      next_cursor: "cur2",
    },
    { results: [{ id: "c3", rich_text: [{ plain_text: "last" }] }], has_more: false },
  ]);
  const client = new NotionClient("tok", impl);

  // The chunked body is reassembled: the flush compares against the WHOLE comment text, so a comment
  // Notion split across rich_text items must not read as a different comment.
  expect(await client.listComments("page-1")).toEqual([
    { id: "c1", text: "Daily check-in part two" },
    { id: "c2", text: "" },
    { id: "c3", text: "last" },
  ]);
  expect(calls[0].url).toBe("https://api.notion.com/v1/comments?block_id=page-1&page_size=100");
  expect(calls[0].method).toBe("GET");
  expect(calls[1].url).toContain("start_cursor=cur2");
});

test("listComments follows a cursor only when Notion both claims more AND supplies one", async () => {
  // This runs inside the comment flush, so an over-eager loop costs a request per comment page on
  // every retry. Either half missing must end the pass after exactly one page.
  const page = (extra: Record<string, unknown>) => ({
    results: [{ id: "c1", rich_text: [{ plain_text: "one" }] }],
    ...extra,
  });
  for (const last of [
    { has_more: true, next_cursor: null }, // claims more, gives nothing to follow
    { has_more: false, next_cursor: "cur9" }, // stale cursor on a final page
    { has_more: true }, // truncated body
  ]) {
    const { calls, impl } = recorder([page(last), page({ has_more: false })]);
    const client = new NotionClient("tok", impl);

    expect(await client.listComments("page-1")).toEqual([{ id: "c1", text: "one" }]);
    expect(calls).toHaveLength(1);
  }
});
