import { Type } from 'typebox';
export const BG_ENABLE_TOOL_NAME = 'bg_enable';
export const BG_RESULT_TOOL_NAME = 'bg_result';
export const TOOL_GROUPS = Object.freeze({
    fusion: Object.freeze(['fusion_reason', 'fusion_investigate', 'fusion_research', 'fusion_validate']),
    delegate: Object.freeze(['bg_delegate']),
    attested: Object.freeze(['bg_run_pi_attested']),
});
const GROUP_NAMES = Object.keys(TOOL_GROUPS);
const RESULT_GROUPS = ['fusion', 'delegate'];
export function parseToolActivationMode(raw) {
    if (raw === undefined || raw === '' || raw === 'eager')
        return 'eager';
    if (raw === 'lazy')
        return 'lazy';
    throw new Error(`pi_bg_config_invalid: PI_BG_TOOL_ACTIVATION accepted values are exactly eager,lazy; received ${JSON.stringify(raw.slice(0, 96))}`);
}
/** Groups whose tools were CALLED on this branch (resume/tree restore), plus result obligation. */
export function usedGroupsFromMessages(messages) {
    const groups = new Set();
    for (const message of messages) {
        if (!message || typeof message !== 'object')
            continue;
        const m = message;
        const names = [];
        if (m.role === 'assistant' && Array.isArray(m.content))
            for (const block of m.content)
                if (block && typeof block === 'object' && block.type === 'toolCall')
                    names.push(String(block.name));
        if (m.role === 'toolResult' && typeof m.toolName === 'string')
            names.push(m.toolName);
        for (const name of names)
            for (const group of GROUP_NAMES)
                if (TOOL_GROUPS[group].includes(name))
                    groups.add(group);
    }
    return { groups, resultOwed: RESULT_GROUPS.some((g) => groups.has(g)) };
}
export function registeredMembers(host, group) {
    const all = new Set(host.allTools());
    return TOOL_GROUPS[group].filter((name) => all.has(name));
}
/** Pure state machine behind bg_enable; unit-tested with a fake ToolHost. */
export function createToolGroupState(host, mode, deps) {
    const enabled = new Set();
    const lazy = mode === 'lazy';
    const available = () => GROUP_NAMES.filter((group) => registeredMembers(host, group).length > 0);
    const desired = (active, resultOwed) => {
        if (!lazy)
            return active.filter((name) => name !== BG_ENABLE_TOOL_NAME);
        const optional = new Set(GROUP_NAMES.flatMap((g) => [...TOOL_GROUPS[g]]));
        optional.add(BG_RESULT_TOOL_NAME);
        const next = active.filter((name) => !optional.has(name) && name !== BG_ENABLE_TOOL_NAME);
        for (const group of enabled)
            next.push(...registeredMembers(host, group));
        const all = new Set(host.allTools());
        if (all.has(BG_RESULT_TOOL_NAME) && (resultOwed || RESULT_GROUPS.some((g) => enabled.has(g)) || deps.hasResultTask()))
            next.push(BG_RESULT_TOOL_NAME);
        if (available().length > 0)
            next.push(BG_ENABLE_TOOL_NAME);
        return [...new Set(next)];
    };
    const apply = (resultOwed = false) => {
        const active = host.activeTools();
        const next = desired(active, resultOwed);
        if (next.length !== active.length || next.some((name, i) => name !== active[i]))
            host.setActiveTools(next);
    };
    const enable = (group) => {
        const avail = available();
        if (typeof group !== 'string' || !avail.includes(group)) {
            return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable group ${JSON.stringify(group)}. Available: ${avail.join(', ') || 'none'}.` }], details: { available: [...avail] } };
        }
        const g = group;
        const names = registeredMembers(host, g);
        if (!lazy)
            return { content: [{ type: 'text', text: `Eager mode: ${names.join(', ')} already active.` }], details: { group: g, enabled: names } };
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
    const restore = (messages) => {
        let used = { groups: new Set(), resultOwed: false };
        try {
            used = usedGroupsFromMessages(messages());
        }
        catch { /* keep defaults; bg_result still follows the registry */ }
        enabled.clear();
        for (const g of used.groups)
            if (registeredMembers(host, g).length > 0)
                enabled.add(g);
        apply(used.resultOwed);
    };
    return { apply, enable, restore };
}
const BgEnableParams = Type.Object({
    group: Type.String({
        description: 'optional tool group to activate',
        enum: ['fusion', 'delegate', 'attested'],
    }),
}, { additionalProperties: false });
/**
 * Registration is unconditional (the docs gate derives availability statically). Eager mode keeps
 * the loader INACTIVE, so eager sessions see exactly upstream's tool list. Pi forbids
 * getAllTools/setActiveTools during loading, so groups resolve against the live registry later.
 */
export function registerToolGroups(pi, mode, deps) {
    const state = createToolGroupState({
        allTools: () => pi.getAllTools().map((tool) => tool.name),
        activeTools: () => pi.getActiveTools(),
        setActiveTools: (names) => pi.setActiveTools(names),
    }, mode, deps);
    pi.registerTool({
        name: BG_ENABLE_TOOL_NAME,
        label: 'Enable background tools',
        description: 'Activate an optional pi-background-tasks tool group for the next model request: fusion (fusion_reason, fusion_investigate, fusion_research, fusion_validate), delegate (bg_delegate), attested (bg_run_pi_attested). Does not start any task. Offered only when PI_BG_TOOL_ACTIVATION=lazy.',
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
//# sourceMappingURL=tool-groups.js.map