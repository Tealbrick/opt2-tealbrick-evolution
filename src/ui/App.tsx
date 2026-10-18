// Owner UI inside the ONE app shell (<AppShell> from @opt2-tealbrick/ui, SDK-API §14): Suggestions, Drafts, Workflows,
// Schedules and Cycles (0.3.0), plus the shared Holds and Agents & scopes pages (./standard.tsx). Every action here is a person op (owner only).
import { useAgents, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { Cycles } from "./Cycles.tsx";
import { Drafts } from "./Drafts.tsx";
import { person } from "./ops.ts";
import { Schedules } from "./Schedules.tsx";
import { Suggestions } from "./Suggestions.tsx";
import { AgentsPage, HoldsPage, portalHref, type Routes, useHoldList, useNav } from "./standard.tsx";
import { Workflows } from "./Workflows.tsx";

const NAME = "Evolving Workflows";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/evolution/`. Suggestions is the launch page (manifest `ui.launchPath`), Agents & scopes is `ui.configurePath`. */
const ROUTES: Routes = { suggestions: "", drafts: "drafts", workflows: "workflows", schedules: "schedules", cycles: "cycles", holds: "holds", agents: "configure" };
const APP_PAGES = [
  { id: "suggestions", label: "Suggestions" },
  { id: "drafts", label: "Drafts" },
  { id: "workflows", label: "Workflows" },
  { id: "schedules", label: "Schedules" },
  { id: "cycles", label: "Cycles" },
];
const PAGES = [...APP_PAGES, ...STANDARD_PAGES.filter((p) => p.id in ROUTES)];

export function App() {
  const { principal, status, signOut } = useSession();
  const directory = useAgents();
  const nav = useNav(ROUTES, "suggestions");
  const holds = useHoldList();
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [openWorkflow, setOpenWorkflow] = useState<string | null>(null);
  const [toReview, setToReview] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  const signedIn = status === "signed_in" && Boolean(principal);
  // The Suggestions count shows on every page (C185, D4): one read at sign-in with the same input the Suggestions page
  // sends; the page keeps it current afterwards. A failed read leaves the nav without a count.
  useEffect(() => {
    if (!signedIn) return;
    person("review_suggestions", { status: "open" })
      .then((r) => setToReview(r.suggestions.length))
      .catch(() => {});
  }, [signedIn]);
  const names = (id: string | null) => (id ? (directory.agents.find((a) => a.id === id)?.name ?? id) : "the owner");
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p.id === "suggestions" ? { ...p, badge: toReview || null } : p));
  const content = (() => {
    switch (nav.page) {
      case "drafts":
        return (
          <Drafts
            openId={openDraft}
            onPromoted={(wf) => {
              setOpenWorkflow(wf);
              nav.go("workflows");
            }}
          />
        );
      case "workflows":
        return <Workflows openId={openWorkflow} stills={STILLS} />;
      case "schedules":
        return <Schedules agents={directory.agents} agentsLoading={directory.loading} />;
      case "cycles":
        return <Cycles />;
      case "holds":
        return <HoldsPage list={holds} only={nav.hold} empty="No calls wait for your approval." />;
      case "agents":
        return <AgentsPage />;
      default:
        return (
          <Suggestions
            names={names}
            onOpenCount={setToReview}
            onDraft={(id) => {
              setOpenDraft(id);
              nav.go("drafts");
            }}
          />
        );
    }
  })();
  return (
    <AppShell
      title={NAME}
      colour={appColour("evolution")}
      art={appArt("evolution", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {signedIn ? content : null}
    </AppShell>
  );
}
