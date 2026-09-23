/**
 * Optional tool groups with on-demand activation (opt-in: PI_BG_TOOL_ACTIVATION=lazy).
 *
 * Eager (default, unchanged upstream behavior): every registered tool is active.
 * Lazy: the always-needed process lifecycle (bg_run/bg_status/bg_logs/bg_kill) stays active; the
 * optional groups — fusion, delegate, attested — start inactive behind a single typed loader,
 * `bg_enable`. Activation affects the next model request (Pi dynamic tools), is idempotent, and
 * stays for the session. `bg_result` is never hidden while a delegate/Fusion result can be owed:
 * it is active whenever its group is active or the branch transcript shows a delegate/Fusion launch.
 *
 * Registration ≠ activation ≠ authorization: the loader can only activate tools this process
 * registered (PI_BG_FEATURES still decides registration), and never bypasses a host's own guard.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const BG_ENABLE_TOOL_NAME = 'bg_enable';
export const BG_RESULT_TOOL_NAME = 'bg_result';

export const TOOL_GROUPS = Object.freeze({
  fusion: Object.freeze(['fusion_reason', 'fusion_investigate', 'fusion_research', 'fusion_validate']),
  delegate: Object.freeze(['bg_delegate']),
  attested: Object.freeze(['bg_run_pi_attested']),
} as const);
export type ToolGroup = keyof typeof TOOL_GROUPS;
const GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];
const RESULT_GROUPS: readonly ToolGroup[] = ['fusion', 'delegate'];

export type ToolActivationMode = 'eager' | 'lazy';

export function parseToolActivationMode(raw: string | undefined): ToolActivationMode {
  if (raw === undefined || raw === '' || raw === 'eager') return 'eager';
  if (raw === 'lazy') return 'lazy';
  throw new Error(`pi_bg_config_invalid: PI_BG_TOOL_ACTIVATION accepted values are exactly eager,lazy; received ${JSON.stringify(raw.slice(0, 96))}`);
}

/** Groups whose tools were CALLED on this branch (resume/tree restore), plus result obligation. */
export function usedGroupsFromMessages(messages: readonly unknown[]): { groups: Set<ToolGroup>; resultOwed: boolean } {
  const groups = new Set<ToolGroup>();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const m = message as { role?: unknown; content?: unknown; toolName?: unknown };
    const names: string[] = [];
    if (m.role === 'assistant' && Array.isArray(m.content))
      for (const block of m.content) if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall') names.push(String((block as { name?: unknown }).name));
    if (m.role === 'toolResult' && typeof m.toolName === 'string') names.push(m.toolName);
    for (const name of names) for (const group of GROUP_NAMES) if ((TOOL_GROUPS[group] as readonly string[]).includes(name)) groups.add(group);
  }
  return { groups, resultOwed: RESULT_GROUPS.some((g) => groups.has(g)) };
}

export interface ToolGroupDependencies {
  readonly branchMessages: (ctx: ExtensionContext) => readonly unknown[];
  /** true when the registry holds a delegate/Fusion task (running or finished, unretrieved or not). */
  readonly hasResultTask: () => boolean;
}

/** The only host operations the group logic needs; no Pi handle escapes into helper code. */
export interface ToolHost {
  readonly allTools: () => readonly string[];
  readonly activeTools: () => readonly string[];
  readonly setActiveTools: (names: string[]) => void;
}

export function registeredMembers(host: ToolHost, group: ToolGroup): string[] {
  const all = new Set(host.allTools());
  return TOOL_GROUPS[group].filter((name) => all.has(name));
}

/** Pure state machine behind bg_enable; unit-tested with a fake ToolHost. */
export function createToolGroupState(host: ToolHost, mode: ToolActivationMode, deps: ToolGroupDependencies) {
  const enabled = new Set<ToolGroup>();
  const lazy = mode === 'lazy';
  const available = (): ToolGroup[] => GROUP_NAMES.filter((group) => registeredMembers(host, group).length > 0);
  const desired = (active: readonly string[], resultOwed: boolean): string[] => {
    if (!lazy) return active.filter((name) => name !== BG_ENABLE_TOOL_NAME);
    const optional = new Set<string>(GROUP_NAMES.flatMap((g) => [...TOOL_GROUPS[g]]));
    optional.add(BG_RESULT_TOOL_NAME);
    const next = active.filter((name) => !optional.has(name) && name !== BG_ENABLE_TOOL_NAME);
    for (const group of enabled) next.push(...registeredMembers(host, group));
    const all = new Set(host.allTools());
    if (all.has(BG_RESULT_TOOL_NAME) && (resultOwed || RESULT_GROUPS.some((g) => enabled.has(g)) || deps.hasResultTask()))
      next.push(BG_RESULT_TOOL_NAME);
    if (available().length > 0) next.push(BG_ENABLE_TOOL_NAME);
    return [...new Set(next)];
  };
  const apply = (resultOwed = false): void => {
    const active = host.activeTools();
    const next = desired(active, resultOwed);
    if (next.length !== active.length || next.some((name, i) => name !== active[i])) host.setActiveTools(next);
  };
  type EnableDetails = { group?: string; available?: string[]; enabled?: string[]; missing?: string[] };
  const enable = (group: unknown): { isError?: boolean; content: { type: 'text'; text: string }[]; details: EnableDetails } => {
    const avail = available();
    if (typeof group !== 'string' || !(avail as string[]).includes(group)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable group ${JSON.stringify(group)}. Available: ${avail.join(', ') || 'none'}.` }], details: { available: [...avail] } };
    }
    const g = group as ToolGroup;
    const names = registeredMembers(host, g);
    if (!lazy) return { content: [{ type: 'text', text: `Eager mode: ${names.join(', ')} already active.` }], details: { group: g, enabled: names } };
    const already = enabled.has(g);
    enabled.add(g);
    apply();
    const active = new Set(host.activeTools());
    const missing = names.filter((name) => !active.has(name));
    if (missing.length > 0) {
      return { isError: true, content: [{ type: 'text', text: `Tools still inactive after activation: ${missing.join(', ')}. A host role policy may restrict them.` }], details: { group: g, missing } };
    }
    return { content: [{ type: 'text', text: `${already ? 'Already enabled' : 'Enabled'}: ${names.join(', ')}. Available on the next request.` }], details: { group: g, enabled: names } };
  };
  const restore = (messages: () => readonly unknown[]): void => {
    let used = { groups: new Set<ToolGroup>(), resultOwed: false };
    try { used = usedGroupsFromMessages(messages()); } catch { /* keep defaults; bg_result still follows the registry */ }
    enabled.clear();
    for (const g of used.groups) if (registeredMembers(host, g).length > 0) enabled.add(g);
    apply(used.resultOwed);
  };
  return { apply, enable, restore };
}

const BgEnableParams = Type.Object(
  {
    group: Type.String({
      description: 'optional tool group to activate',
      enum: ['fusion', 'delegate', 'attested'],
    }),
  },
  { additionalProperties: false },
);

/**
 * Registration is unconditional (the docs gate derives availability statically). Eager mode keeps
 * the loader INACTIVE, so eager sessions see exactly upstream's tool list. Pi forbids
 * getAllTools/setActiveTools during loading, so groups resolve against the live registry later.
 */
export function registerToolGroups(pi: ExtensionAPI, mode: ToolActivationMode, deps: ToolGroupDependencies): void {
  const state = createToolGroupState(
    {
      allTools: () => pi.getAllTools().map((tool) => tool.name),
      activeTools: () => pi.getActiveTools(),
      setActiveTools: (names) => pi.setActiveTools(names),
    },
    mode,
    deps,
  );
  pi.registerTool({
    name: BG_ENABLE_TOOL_NAME,
    label: 'Enable background tools',
    description:
      'Activate an optional pi-background-tasks tool group for the next model request: fusion (fusion_reason, fusion_investigate, fusion_research, fusion_validate), delegate (bg_delegate), attested (bg_run_pi_attested). Does not start any task. Offered only when PI_BG_TOOL_ACTIVATION=lazy.',
    promptSnippet: 'activate an optional background tool group (fusion, delegate, attested)',
    parameters: BgEnableParams,
    async execute(_id, params) {
      return state.enable(params.group);
    },
  });
  // Registered after the feature modules' own session_start re-activation, so these run later.
  pi.on('session_start', (_event, ctx) => {
    state.restore(() => deps.branchMessages(ctx));
  });
  pi.on('session_tree', (_event, ctx) => {
    state.restore(() => deps.branchMessages(ctx));
  });
  pi.on('before_agent_start', () => {
    state.apply();
  });
}
