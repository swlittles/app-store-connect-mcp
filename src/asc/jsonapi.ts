import type { Linkage, Resource } from "./client.js";

/** The single related ID of a to-one relationship, if the response included linkage data. */
export function relId(resource: Resource<unknown>, name: string): string | undefined {
  const data = resource.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

/** The related IDs of a to-many relationship, in Apple's order. */
export function relIds(resource: Resource<unknown>, name: string): string[] {
  const data = resource.relationships?.[name]?.data;
  return Array.isArray(data) ? data.map((d) => d.id) : [];
}

/** Indexes `included` resources by type and ID. */
export class Included {
  private readonly map = new Map<string, Resource>();

  constructor(resources: Resource[] = []) {
    for (const r of resources) this.map.set(`${r.type}/${r.id}`, r);
  }

  get<A>(type: string, id: string | undefined): Resource<A> | undefined {
    return id ? (this.map.get(`${type}/${id}`) as Resource<A> | undefined) : undefined;
  }

  /** Follows a to-one relationship from `resource` into `included`. */
  one<A>(resource: Resource<unknown>, name: string, type: string): Resource<A> | undefined {
    return this.get<A>(type, relId(resource, name));
  }

  /** Follows a to-many relationship from `resource` into `included`, keeping Apple's order. */
  many<A>(resource: Resource<unknown>, name: string, type: string): Resource<A>[] {
    return relIds(resource, name)
      .map((id) => this.get<A>(type, id))
      .filter((r): r is Resource<A> => r !== undefined);
  }
}

export function linkage(type: string, id: string): { data: Linkage } {
  return { data: { type, id } };
}

export function linkages(type: string, ids: readonly string[]): { data: Linkage[] } {
  return { data: ids.map((id) => ({ type, id })) };
}
