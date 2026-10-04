import { z } from "zod";
import { AscApiError, type Resource } from "../asc/client.js";
import { linkage, linkages, relIds } from "../asc/jsonapi.js";
import { runBulk } from "../asc/jobs.js";
import type { BetaGroupAttributes, BetaTesterAttributes } from "../asc/types.js";
import { STEP_LEGEND, StepLog, plural } from "./format.js";
import { defineTool, UserError, type ToolContext } from "./framework.js";
import { appInput, listGroups, resolveApp, resolveGroups } from "./lookup.js";

export const listBetaGroups = defineTool({
  name: "list_beta_groups",
  title: "List beta groups",
  description: "Lists an app's TestFlight groups: internal or external, access to all builds, public link, feedback, tester count and ID.",
  kind: "read",
  input: { app: appInput },
  async run({ app }, ctx) {
    const ref = await resolveApp(ctx, app);
    const groups = await listGroups(ctx, ref.id);
    if (!groups.length) return `${ref.name} has no beta groups. Create one with create_beta_group.`;
    const counts = await Promise.all(
      groups.map((g) =>
        ctx.asc
          .get<Resource[]>(`/v1/betaGroups/${g.id}/relationships/betaTesters`, { limit: 1 })
          .then((doc) => doc.meta?.paging?.total ?? doc.data.length)
          .catch(() => undefined),
      ),
    );
    return [
      `${ref.name}: ${plural(groups.length, "beta group")}`,
      ...groups.map((g, i) => {
        const a = g.attributes ?? {};
        const parts = [`- "${a.name}"`, a.isInternalGroup ? "internal" : "external"];
        if (a.hasAccessToAllBuilds) parts.push("gets all builds");
        if (a.publicLinkEnabled) parts.push(`public link ${a.publicLink ?? "on"}${a.publicLinkLimitEnabled ? ` (limit ${a.publicLinkLimit})` : ""}`);
        parts.push(`feedback ${a.feedbackEnabled ? "on" : "off"}`);
        if (counts[i] !== undefined) parts.push(plural(counts[i]!, "tester"));
        parts.push(`id ${g.id}`);
        return parts.join(" · ");
      }),
    ].join("\n");
  },
});

export const listTesters = defineTool({
  name: "list_testers",
  title: "List testers",
  description: "Lists TestFlight testers for an app, or for one group, with email, name, status, invite type and groups.",
  kind: "read",
  input: {
    app: appInput,
    group: z.string().optional().describe("Group name or ID. Omit for every tester of the app."),
    email: z.string().optional().describe("Only this tester."),
  },
  async run({ app, group, email }, ctx) {
    const ref = await resolveApp(ctx, app);
    const groups = await listGroups(ctx, ref.id);
    const groupNames = new Map(groups.map((g) => [g.id, g.attributes?.name ?? g.id]));
    const query: Record<string, string | number> = { "filter[apps]": ref.id, include: "betaGroups", "fields[betaGroups]": "name", "limit[betaGroups]": 50 };
    let scope = ref.name;
    if (group) {
      const [g] = await resolveGroups(ctx, ref.id, [group]);
      query["filter[betaGroups]"] = g!.id;
      scope = `"${g!.attributes?.name}"`;
    }
    if (email) query["filter[email]"] = email;
    const { data } = await ctx.asc.getAll<BetaTesterAttributes>("/v1/betaTesters", query, { max: 500 });
    if (!data.length) return `No testers in ${scope}${email ? ` with email ${email}` : ""}.`;
    return [
      `${scope}: ${plural(data.length, "tester")}${data.length === 500 ? " (first 500)" : ""}`,
      ...data.map((t) => {
        const a = t.attributes ?? {};
        const name = [a.firstName, a.lastName].filter(Boolean).join(" ");
        const inGroups = relIds(t, "betaGroups")
          .filter((id) => groupNames.has(id))
          .map((id) => groupNames.get(id));
        return `- ${a.email ?? "(public link tester)"}${name ? ` (${name})` : ""} · ${a.state ?? "?"} · ${a.inviteType ?? "?"}${inGroups.length ? ` · groups: ${inGroups.join(", ")}` : ""} · id ${t.id}`;
      }),
    ].join("\n");
  },
});

export const createBetaGroup = defineTool({
  name: "create_beta_group",
  title: "Create a beta group",
  description:
    "Creates a TestFlight group, or returns the existing one with the same name. External groups can have a public link anyone can join. " +
    "Internal groups can only contain people who are already App Store Connect users on the team.",
  kind: "write",
  input: {
    app: appInput,
    name: z.string().min(1),
    internal: z.boolean().default(false),
    all_builds: z.boolean().optional().describe("Internal groups only: automatically get every new build."),
    public_link: z.boolean().default(false).describe("External groups only: turn on a public invite link."),
    public_link_limit: z.number().int().min(1).max(10000).optional().describe("Maximum testers who can join through the public link."),
    feedback: z.boolean().default(true).describe("Let testers send feedback and screenshots."),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    if (args.internal && args.public_link) throw new UserError("Internal groups can't have a public link.");
    const existing = (await listGroups(ctx, ref.id)).find((g) => g.attributes?.name?.toLowerCase() === args.name.toLowerCase());
    if (existing) {
      return `Group "${existing.attributes?.name}" already exists (${existing.attributes?.isInternalGroup ? "internal" : "external"}, id ${existing.id})${existing.attributes?.publicLink ? `, public link ${existing.attributes.publicLink}` : ""}.`;
    }
    const attributes: Record<string, unknown> = { name: args.name, feedbackEnabled: args.feedback };
    if (args.internal) {
      attributes.isInternalGroup = true;
      if (args.all_builds !== undefined) attributes.hasAccessToAllBuilds = args.all_builds;
    } else {
      attributes.publicLinkEnabled = args.public_link;
      if (args.public_link_limit) {
        attributes.publicLinkLimitEnabled = true;
        attributes.publicLinkLimit = args.public_link_limit;
      }
    }
    if (ctx.dryRun) return `Would create ${args.internal ? "internal" : "external"} group "${args.name}" for ${ref.name}.`;
    const created = await ctx.asc.post<Resource<BetaGroupAttributes>>("/v1/betaGroups", {
      data: { type: "betaGroups", attributes, relationships: { app: linkage("apps", ref.id) } },
    });
    const g = created!.data;
    return `Created ${g.attributes?.isInternalGroup ? "internal" : "external"} group "${g.attributes?.name}" (id ${g.id})${g.attributes?.publicLink ? `. Public link: ${g.attributes.publicLink}` : ""}.`;
  },
});

const testerInput = z.union([
  z.string().email(),
  z.object({ email: z.string().email(), first_name: z.string().optional(), last_name: z.string().optional() }),
]);

export const inviteTesters = defineTool({
  name: "invite_testers",
  title: "Invite testers",
  description:
    "Adds testers to a beta group, inviting them if they're new. People already invited elsewhere are added to the group instead of failing. " +
    "External groups accept any email; internal groups only accept App Store Connect users on the team. Safe to re-run with the same list.",
  kind: "write",
  input: {
    app: appInput,
    group: z.string().describe("Group name or ID."),
    testers: z.array(testerInput).min(1).max(500).describe('Emails, or objects like {"email": "a@b.com", "first_name": "Ada"}.'),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const [group] = await resolveGroups(ctx, ref.id, [args.group]);
    const g = group!;
    const testers = args.testers.map((t) => (typeof t === "string" ? { email: t } : t));
    const log = new StepLog();

    const result = await runBulk(
      testers,
      async (t) => {
        const email = t.email.trim();
        const found = await findTester(ctx, email);
        if (found && relIds(found, "betaGroups").includes(g.id)) {
          log.skip(`${email} is already in "${g.attributes?.name}"`);
          return;
        }
        if (ctx.dryRun) {
          log.plan(found ? `Add existing tester ${email} to the group` : `Invite ${email}`);
          return;
        }
        if (found) {
          await ctx.asc.post(`/v1/betaGroups/${g.id}/relationships/betaTesters`, linkages("betaTesters", [found.id]));
          log.done(`Added existing tester ${email}`);
          return;
        }
        try {
          await ctx.asc.post("/v1/betaTesters", {
            data: {
              type: "betaTesters",
              attributes: { email, firstName: "first_name" in t ? t.first_name : undefined, lastName: "last_name" in t ? t.last_name : undefined },
              relationships: { betaGroups: linkages("betaGroups", [g.id]) },
            },
          });
          log.done(`Invited ${email}`);
        } catch (error) {
          if (error instanceof AscApiError && error.status === 409) {
            // Already a tester somewhere on the team: add the existing record to this group.
            const again = await findTester(ctx, email);
            if (again) {
              await ctx.asc.post(`/v1/betaGroups/${g.id}/relationships/betaTesters`, linkages("betaTesters", [again.id]));
              log.done(`Added existing tester ${email}`);
              return;
            }
            if (g.attributes?.isInternalGroup) {
              throw new Error(`${email} isn't an App Store Connect user on this team; internal groups only take team members. Add them in Users and Access first, or use an external group.`);
            }
          }
          throw error;
        }
      },
      { concurrency: 2, asc: ctx.asc, signal: ctx.signal, onProgress: (n, total) => ctx.progress(`Testers: ${n} of ${total}`, n, total) },
    );
    for (const f of result.failed) log.fail(`${f.item.email}: ${f.error}`);
    for (const n of result.notAttempted) log.warn(`${n.email}: not attempted`);
    const tail = result.stopReason ? [`Stopped early: ${result.stopReason}. Run again with the same list to finish.`] : [];
    if (result.failed.length) tail.push("Run again with the same list to retry the failures; finished testers are skipped.");
    return [`Group "${g.attributes?.name}" (${g.attributes?.isInternalGroup ? "internal" : "external"}, id ${g.id})`, STEP_LEGEND, log.toString(), ...tail].join("\n");
  },
});

export const removeTesters = defineTool({
  name: "remove_testers",
  title: "Remove testers",
  description:
    "Removes testers from one beta group, or from the app entirely (every group, and their access to builds) when group is omitted.",
  kind: "destructive",
  input: {
    app: appInput,
    group: z.string().optional().describe("Group name or ID. Omit to remove the testers from the app entirely."),
    emails: z.array(z.string().email()).min(1).max(500),
  },
  async run(args, ctx) {
    const ref = await resolveApp(ctx, args.app);
    const group = args.group ? (await resolveGroups(ctx, ref.id, [args.group]))[0] : undefined;
    const log = new StepLog();
    const ids: string[] = [];
    for (const email of args.emails) {
      const t = await findTester(ctx, email, ref.id);
      if (!t) log.skip(`${email} isn't a tester of ${ref.name}`);
      else if (group && !relIds(t, "betaGroups").includes(group.id)) log.skip(`${email} isn't in "${group.attributes?.name}"`);
      else {
        ids.push(t.id);
        log.step(ctx.dryRun, `Remove ${email} from ${group ? `"${group.attributes?.name}"` : `${ref.name} (all groups)`}`);
      }
    }
    if (ids.length && !ctx.dryRun) {
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        if (group) await ctx.asc.delete(`/v1/betaGroups/${group.id}/relationships/betaTesters`, linkages("betaTesters", chunk));
        else await ctx.asc.delete(`/v1/apps/${ref.id}/relationships/betaTesters`, linkages("betaTesters", chunk));
      }
    }
    return [STEP_LEGEND, log.toString()].join("\n");
  },
});

async function findTester(ctx: ToolContext, email: string, appId?: string): Promise<Resource<BetaTesterAttributes> | undefined> {
  const doc = await ctx.asc.get<Resource<BetaTesterAttributes>[]>("/v1/betaTesters", {
    "filter[email]": email,
    "filter[apps]": appId,
    include: "betaGroups",
    "fields[betaGroups]": "name",
    "limit[betaGroups]": 50,
    limit: 5,
  });
  return doc.data.find((t) => t.attributes?.email?.toLowerCase() === email.toLowerCase());
}
