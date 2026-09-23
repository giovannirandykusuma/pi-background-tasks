---
doc_id: tools/bg_enable
audience: agent
mode: mixed
review_policy: contract
stability: evolving
covers_surfaces: [tool:bg_enable]
covers_sources: []
---
# `bg_enable`

<!-- pi-docs:begin name="tool-contract-bg_enable" generator="scripts/docs/generate.mjs" -->
- Label: **Enable background tools**
- Source: `src/tool-groups.ts:146`
- Availability: `any(feature:delegate,feature:fusion)`
- Available by default: **yes**
- Description: Activate an optional pi-background-tasks tool group for the next model request: fusion (fusion_reason, fusion_investigate, fusion_research, fusion_validate), delegate (bg_delegate), attested (bg_run_pi_attested). Does not start any task. Offered only when PI_BG_TOOL_ACTIVATION=lazy.
- Root schema: `object`; additionalProperties: `false`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `group` | yes | `string` | optional tool group to activate | enum `fusion` \| `delegate` \| `attested` |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "additionalProperties": false,
  "properties": {
    "group": {
      "description": "optional tool group to activate",
      "enum": [
        "fusion",
        "delegate",
        "attested"
      ],
      "type": "string"
    }
  },
  "required": [
    "group"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bg_enable" -->

Activate one optional tool group for the next model request.

## Schema

Required fields:

- `group: "fusion" | "delegate" | "attested"`.

## When to use

Only when `PI_BG_TOOL_ACTIVATION=lazy`: the optional groups (Fusion, `bg_delegate`, `bg_run_pi_attested`) then start inactive and this loader is the one way to activate them. `bg_run`, `bg_status`, `bg_logs` and `bg_kill` are always active. With the default `eager` mode the loader is registered but kept inactive and every tool is active as upstream.

## Defaults

`PI_BG_TOOL_ACTIVATION` accepts exactly `eager` (default) or `lazy`; anything else fails configuration.

## Lifecycle

Activation takes effect on the next model request (Pi dynamic tools), is idempotent (`Already enabled`), and stays for the session. On `session_start`/`session_tree` the groups whose tools were called on the current branch are restored. `bg_result` is active whenever the Fusion or delegate group is active, the branch shows a delegate/Fusion call, or the registry holds a delegate/Fusion task, so an owed result is never unreachable.

## Examples

```json
{"group":"fusion"}
```

## Output/result

`Enabled: <tools>. Available on the next request.` with details `{ group, enabled }`.

## Errors

- Unknown group or a group whose feature is disabled by `PI_BG_FEATURES`: error listing available groups.
- Tools still inactive after activation (a host role policy restricted them): error naming them.

## Runtime artifacts

None. Visibility only; no task is started.

## Safety boundaries

Activation is not authorization: it can only activate tools this process registered, and a host (for example a role guard) may still block a call. It never widens `PI_BG_FEATURES`.

## Related docs

- [`bg_result`](bg_result.md)
- [`fusion_reason`](fusion_reason.md)
- [`bg_delegate`](bg_delegate.md)

## Source ownership/reference

`src/tool-groups.ts` owns the group state machine; registration is wired at the end of `src/extension.ts`.
