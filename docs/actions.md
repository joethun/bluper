# Actions System

Actions are the trigger layer for user-initiated operations. They connect keyboard shortcuts, UI buttons, and context menus to editor functionality.

All paths below are relative to `apps/web/`.

## Adding a New Action

### 1. Define the action — `src/actions/definitions.ts`

Add an entry to the `ACTIONS` object:

```typescript
"my-action": {
    description: "What it does",
    category: "editing",           // playback | navigation | editing | selection | history | timeline | controls | assets
    defaultShortcuts: ["ctrl+m"],  // optional
    args: { someValue: "number" }, // optional, only if it takes args
},
```

`TAction` is `keyof typeof ACTIONS`, so the entry is what makes the name valid everywhere else.

**If your shortcut uses a special key** (not a letter/digit), check `getPressedKey` in `src/actions/keybindings-store.ts` and add a case if it's missing:

```typescript
if (key === "escape") return "escape";
```

**If your action has a `defaultShortcuts`, existing users will not get it.** Keybindings persist to `localStorage` under `bluper-keybindings`, and the store's `merge` replaces the whole keybinding map with the persisted one rather than layering new defaults over it — so a new default reaches fresh installs only. There is deliberately no migration chain: the store is pinned at `version: 1` with `partialize`/`merge` and no `migrate`. If a new default has to reach existing users, that hook has to be added first; don't assume it exists.

### 2. Register the handler — `src/actions/use-editor-actions.ts`

```typescript
useActionHandler(
    "my-action",
    () => {
        editor.timeline.doSomething();
    },
    undefined, // isActive: MutableRefObject<boolean> | boolean | undefined
);
```

`useActionHandler` takes positional arguments rather than an options object — it carries an explicit `bluper/prefer-object-params` exemption in `src/actions/use-action-handler.ts`, because the subscription reads best as `(action, handler, isActive)`.

### 3. Register arg types (if needed) — `src/actions/types.ts`

Only required if your action accepts arguments:

```typescript
export type TActionArgsMap = {
    // ...existing actions...
    "my-action": { someValue: number } | undefined; // | undefined = optional args
};
```

## Invoking Actions

Use `invokeAction` for any user-triggered operation (buttons, context menus, etc.):

```typescript
import { invokeAction } from "@/actions";

invokeAction("my-action");
invokeAction("seek-forward", { seconds: 5 });
```

Avoid calling `editor.xxx()` directly from UI components — that bypasses the action layer (toasts, validation feedback, keybinding support).

## The `isActive` parameter

The third argument to `useActionHandler` controls when the handler is active:

- `undefined` — always active
- `true` / `false` — statically enabled/disabled
- `MutableRefObject<boolean>` — reactive, toggled at runtime (e.g. only active when a panel is focused)

## How a keypress becomes an edit

```
key event
  → getPressedKey / generateKeybindingString   src/actions/keybindings-store.ts
  → keybindings map lookup (chord → action)    src/actions/keybindings-store.ts
  → invokeAction                               src/actions/registry.ts
  → bound handler                              src/actions/use-editor-actions.ts
  → manager method                             src/core/managers/*
  → new XCommand(...) → command.execute()      src/commands/*
  → timeline.updateTracks(next)
  → ChangeNotifier → subscribed components     src/core/managers/change-notifier.ts
```

`src/actions/registry.ts` holds the binding table (`bindAction` / `unbindAction` / `invokeAction`); `src/actions/use-keybindings.ts` owns the window listener.
