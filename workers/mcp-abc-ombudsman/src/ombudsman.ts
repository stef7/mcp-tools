/**
 * The ABC Ombudsman's complaint findings, as served by abc.net.au's CoreMedia CMS.
 *
 * The shape is three levels deep: a root meta-collection holds the outcome categories, most
 * categories hold one sub-collection per year, and those hold the findings themselves. Only
 * "Statements and Reports" is flat, which is why walking has to branch on collection type.
 */
const API = "https://www.abc.net.au/core-next/api";
const PATH = "about/ombudsman/recent-complaints-and-reports";
export const ROOT = "103532774";

export type Category = { id: string; title: string; type: string };

/**
 * The categories as of the last look. `list_categories` re-reads them live; these are the
 * fallback, and what the crawling tools work from so a crawl cannot be derailed by one bad
 * response mid-way.
 */
export const CATEGORIES: Category[] = [
  { id: "106262348", title: "Noteworthy No Breach Findings", type: "MetaCollection" },
  { id: "103532876", title: "Breach Findings", type: "MetaCollection" },
  { id: "103532880", title: "Action Taken", type: "MetaCollection" },
  { id: "106273562", title: "Review Findings", type: "MetaCollection" },
  { id: "103772564", title: "Statements and Reports", type: "StandardCollection" },
];

type Item = {
  id?: string;
  cardId?: string;
  title?: string;
  cardTitle?: string;
  description?: string;
  articleLink?: string;
  collectionType?: string;
  itemsCount?: number;
  cardAttributionPrepared?: { publishedDate?: string };
};
type Collection = {
  collection?: {
    items?: Item[];
    heading?: string;
    title?: string;
    pagination?: { total?: number; offset?: number };
  };
};
export type Finding = {
  category: string;
  title: string;
  description: string;
  url: string;
  date: string;
  id: string;
};

const read = async (url: string): Promise<Collection> => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ABC API ${res.status}: ${url}`);
  return res.json();
};

/** A meta-collection: the categories under the root, or the years under a category. */
export const metaCollection = (collectionId: string) =>
  read(
    `${API}/metaCollection/${PATH}?collectionId=${collectionId}` +
      `&rootMetaCollectionId=${ROOT}&metaInMeta=true`,
  );

/** A plain collection: the findings themselves. */
export const collection = (collectionId: string, size = 200, offset = 0) =>
  read(
    `${API}/collection/core-next/api/collection/${PATH}?rootMetaCollectionId=${ROOT}` +
      `&collectionId=${collectionId}&size=${size}&offset=${offset}`,
  );

export const asFinding = (item: Item, category: string): Finding => ({
  category,
  title: item.cardTitle ?? item.title ?? "",
  description: item.description ?? "",
  url: item.articleLink ?? "",
  date: item.cardAttributionPrepared?.publishedDate ?? "",
  id: item.cardId ?? item.id ?? "",
});

export const asSubCollection = (item: Item) => ({
  id: item.id,
  title: item.title,
  type: item.collectionType,
  items_count: item.itemsCount,
});

/**
 * Every finding in one category. A flat category is one request; a year-by-year one fetches
 * its years together, and a year that fails becomes a row saying so rather than losing the
 * whole crawl.
 */
export const walk = async (cat: Category): Promise<Finding[]> => {
  if (cat.type === "StandardCollection") {
    const data = await collection(cat.id);
    return (data.collection?.items ?? []).map((i) => asFinding(i, cat.title));
  }
  const years = (await metaCollection(cat.id)).collection?.items ?? [];
  const fetched = await Promise.all(
    years.map(async (year) => {
      try {
        const data = await collection(String(year.id));
        return (data.collection?.items ?? []).map((i) => asFinding(i, cat.title));
      } catch (e) {
        const description = e instanceof Error ? e.message : String(e);
        const title = `ERROR fetching year ${year.title}`;
        return [{ category: cat.title, title, description, url: "", date: "", id: "" }];
      }
    }),
  );
  return fetched.flat();
};

/** The categories a filter names: by substring of the title, or by exact ID. */
export const categoriesMatching = (filter?: string) => {
  if (!filter) return CATEGORIES;
  const want = filter.toLowerCase();
  return CATEGORIES.filter((c) => c.title.toLowerCase().includes(want) || c.id === filter);
};
