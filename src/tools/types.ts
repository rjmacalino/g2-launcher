// What the shell knows about a tool.
//
// This interface is the registry that G2-3's review argued against, and the
// argument then was right: one tool with behaviour did not justify designing
// against tools that did not exist.
//
// What changed is that the shell grew five separate `index === GPS_INDEX` and
// `index === TELEPROMPTER_INDEX` branches, in page construction, open, close,
// foreground enter, and scroll routing. Moving tools into their own files without
// this would have scattered those branches across more files rather than removing
// them, which is renaming a problem rather than fixing it.
//
// Every hook is optional on purpose. Weather and Notes are still placeholders and
// implement nothing but a name and their initial content. A tool pays only for the
// lifecycle it actually uses.
export type Tool = {
  // Shown in the launcher list. Order in the TOOLS array is the index the
  // firmware reports back as currentSelectItemIndex.
  readonly name: string

  // What the content area shows the moment the page is built, before any async
  // work has had a chance to produce something better. Must be synchronous: it is
  // called while assembling the container payload.
  initialContent(): string

  // Restore persisted state at startup. Awaited (with a timeout) before the shell
  // decides what page to show, so initialContent can rely on it having run.
  hydrate?(): Promise<void>

  // The page is now on screen. Start subscriptions and timers here rather than in
  // initialContent, because anything that updates the content area needs the
  // container to exist first.
  onOpen?(): void

  // Leaving the page. Stop everything onOpen started. Called before the rebuild
  // that replaces the page, so a late update cannot land on a container that is
  // about to be replaced.
  onClose?(): void

  // App returned to the foreground while this tool was showing. The OS may have
  // suspended whatever onOpen started.
  onResume?(): void

  // App went to the background while this tool was showing.
  onSuspend?(): void

  // Scroll gesture while this tool is showing. Only called for the active tool,
  // which is why no tool needs to check whether it is the one on screen.
  onScroll?(delta: 1 | -1): void
}
