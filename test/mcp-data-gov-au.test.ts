/**
 * mcp-data-gov-au. CKAN is not called; what is pinned down here is the row-echo cap, the
 * dataset listing, and the tool list.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import Worker from "../workers/mcp-data-gov-au/src/index";
import { describeDatasets, echoRecords, fieldLine } from "../workers/mcp-data-gov-au/src/ckan";

type Spec = { name: string; description: string; annotations: Record<string, boolean> };

const tools = () => new Worker(createExecutionContext(), env).tools({}) as Promise<Spec[]>;

describe("the tool list", () => {
  it("carries the worker's prefix and reads only", async () => {
    const specs = await tools();
    expect(specs.map((t) => t.name)).toEqual([
      "data_gov_au_datastore_sql",
      "data_gov_au_datastore_search",
      "data_gov_au_datastore_fields",
      "data_gov_au_package_search",
    ]);
    expect(specs.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("shows the ACNC resource ID in the SQL example, so it can be copied", async () => {
    const sql = (await tools()).find((t) => t.name === "data_gov_au_datastore_sql");
    expect(sql!.description).toContain('"8fb32972-24e9-4c95-885e-7140be51be8a"');
  });
});

describe("echoing records", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ _id: i }));

  it("says how many it held back", () => {
    const out = echoRecords(rows, 2);
    expect(out).toContain("[showing 2 of 5 fetched");
    expect(JSON.parse(out.split("\n\n[")[0]!)).toHaveLength(2);
  });

  it("adds no note when everything fitted", () => {
    expect(echoRecords(rows, 10)).not.toContain("showing");
  });
});

describe("field lists", () => {
  it("pairs each column with its type", () => {
    expect(
      fieldLine([
        { id: "ABN", type: "text" },
        { id: "_id", type: "int" },
      ]),
    ).toBe("ABN:text, _id:int");
  });

  it("copes with a resource that reported no fields", () => {
    expect(fieldLine()).toBe("");
  });
});

describe("listing datasets", () => {
  it("marks which resources can actually be queried", () => {
    const out = describeDatasets(
      {
        count: 2,
        results: [
          {
            title: "ACNC Register",
            name: "acnc-register",
            resources: [
              { id: "abc", name: "Main register", format: "CSV", datastore_active: true },
              { id: "def", format: "PDF" },
            ],
          },
        ],
      },
      "ACNC",
      0,
    );
    expect(out).toContain('2 dataset(s) match "ACNC". Showing 1 (start=0).');
    expect(out).toContain("resource_id=abc  datastore_active=true");
    expect(out).toContain("resource_id=def  datastore_active=false");
  });

  it("says a dataset has no resources rather than leaving a blank", () => {
    expect(describeDatasets({ count: 1, results: [{ title: "Empty" }] }, "x", 0)).toContain(
      "(none)",
    );
  });
});
