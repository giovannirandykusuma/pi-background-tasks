---
doc_id: tools/bg_wait
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:bg_wait]
covers_sources: []
---
# `bg_wait`

<!-- pi-docs:begin name="tool-contract-bg_wait" generator="scripts/docs/generate.mjs" -->
- Label: **Background Wait**
- Source: `src/extension.ts:1161`
- Availability: `always`
- Available by default: **yes**
- Description: Block until one background task ends or the timeout passes (default 300 s, max 600 s), then return its status and a short output tail. The waiting primitive for callers that are never woken by a completion notification; one call replaces a bg_status polling loop.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `taskId` | yes | `string` | Task ID or unambiguous prefix to wait for |  |
| `timeoutSeconds` | no | `number` | Longest time to block, in seconds (1-600). Default: 300. On timeout the task keeps running; call bg_wait again. |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "taskId": {
      "description": "Task ID or unambiguous prefix to wait for",
      "type": "string"
    },
    "timeoutSeconds": {
      "description": "Longest time to block, in seconds (1-600). Default: 300. On timeout the task keeps running; call bg_wait again.",
      "type": "number"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bg_wait" -->

Block until one background task ends, or until a bounded timeout passes.

## Schema


Required fields:

- `taskId: string` — exact task id or unambiguous prefix.

Optional fields:

- `timeoutSeconds: number` — longest time to block, normalized to `[1, 600]`. Default `300`.

## When to use

Use when the result must be in hand in the same turn and no completion notification will wake you — for example a subagent that is never re-prompted after its own background job ends. One `bg_wait` call replaces a `bg_status` polling loop.

When the default automatic notification will wake you, prefer continuing other work or ending the turn.

## Defaults

- `timeoutSeconds`: `300`; values above `600` are capped, below `1` are raised to `1`.

## Lifecycle

The wait subscribes to the task's own terminal signal; it does not poll. It returns at the moment the task leaves `running`, when the timeout passes, or when the tool call is aborted. A timeout or abort never stops the task; the waiter is removed.

## Examples

```json
{"taskId":"b12345678"}
```

```json
{"taskId":"b1234","timeoutSeconds":600}
```

## Output/result

Text content is the task snapshot. When the task is terminal it is followed by `Output tail:` and up to 4 KiB of the output tail (with the full-output path). When the timeout passes first it is followed by `Still running after <n> s. Call bg_wait again to keep waiting; do not poll bg_status.` Structured details:

```ts
{ tasks: [BgTaskSnapshot] }
```

## Errors

- Missing/empty id: `Task ID is required`.
- Unknown id/prefix: `Unknown background task ID: <id>`.
- Ambiguous prefix: lists matching task ids.

## Runtime artifacts

Reads the task's output file only after the task is terminal; does not modify output or metadata.

## Safety boundaries

Bounded (at most 600 s per call, 4 KiB of output). Does not start, stop, or change tasks. Terminal notifications are unaffected: a task observed through `bg_wait` still publishes its normal completion notification.

## Related docs

- [`bg_status`](bg_status.md)
- [`bg_logs`](bg_logs.md)
- [`bg_run`](bg_run.md)
- [Completion delivery](../concepts/completion-delivery.md)
- [Background task runtime](../subsystems/background-task-runtime.md)

## Source ownership/reference

Tool registration lives in `src/extension.ts`; the wait is `BackgroundTaskRegistry.waitForTask`, owned by [background-task-runtime](../subsystems/background-task-runtime.md).
