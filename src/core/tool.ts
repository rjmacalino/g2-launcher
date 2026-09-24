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
// Every hook is optional on purpose. A tool pays only for the lifecycle it
// actually uses - Weather, for instance, has no onScroll or onListSelect at
// all, since nothing in a forecast is tappable or scrollable content.
export type Tool = {
  // Shown in the launcher list. Order in the TOOLS array is the index the
  // firmware reports back as currentSelectItemIndex.
  readonly name: string

  // Ask before leaving, instead of leaving immediately on double tap.
  //
  // A function, not a static flag, because whether leaving is dangerous can
  // depend on the tool's own internal state. Teleprompter only wants this
  // while actually reading a script; browsing its own script picker has
  // nothing to lose, so a confirmation there would be pure friction.
  //
  // Opt in, not universal. A confirmation on a placeholder protects nothing.
  confirmOnExit?(): boolean

  // The question shown on the leave prompt. Omitted defaults to
  // `Leave ${name}?`, correct for a tool with one level of depth.
  //
  // A function, same reasoning as confirmOnExit: what leaving actually means
  // can depend on internal state. Teleprompter's reading mode does not leave
  // the tool at all, it backs up to the script picker (see onConfirmedExit),
  // so its default question would be actively wrong there - claiming to leave
  // Teleprompter when Yes keeps you inside it. Asking the tool for its own
  // wording keeps the dialog honest about what pressing Yes actually does,
  // rather than the shell guessing from the tool's name alone.
  confirmPrompt?(): string

  // What the content area shows the moment the page is built, before any async
  // work has had a chance to produce something better. Must be synchronous: it is
  // called while assembling the container payload.
  initialContent(): string

  // Restore persisted state at startup. Awaited (with a timeout) before the shell
  // decides what page to show, so initialContent can rely on it having run.
  hydrate?(): Promise<void>

  // Refresh anything this tool wants freshly loaded before THIS particular
  // open, awaited before the page is built. Unlike hydrate, which runs once at
  // startup, this runs every time the tool is opened. Matters for a tool whose
  // content can change while the app is already running: Teleprompter's script
  // picker needs the list of saved scripts as they are right now, not as they
  // were at launch.
  beforeOpen?(): Promise<void>

  // Which kind of content container this tool wants for its CURRENT open.
  // 'text' is the default when omitted, matching every tool before this one.
  // A tool can switch between kinds across its own internal navigation:
  // Teleprompter is a list (choosing a script) until one is picked, then text
  // (reading it), and can return to the list on its next open.
  contentKind?(): 'text' | 'list' | 'image'

  // Item labels shown when contentKind() is 'list'. Native firmware selection
  // and highlight, the same widget the launcher menu itself uses.
  listItems?(): string[]

  // Container size when contentKind() is 'image', in pixels. Defaults to the
  // platform maximum (288 x 144, see platform/page.ts's IMAGE_MAX_WIDTH /
  // IMAGE_MAX_HEIGHT) when omitted - most images want as much room as this
  // platform allows a single image container, not a smaller one.
  //
  // The shell only declares the container; sending pixels into it is the
  // tool's own job; from onOpen, via platform/page.ts's setImage(), once the
  // container exists (an image container cannot receive data at the same
  // time it is created - see updateImageRawData in the SDK). An image
  // container also cannot capture input, so the shell places an invisible
  // full-area text container behind it to receive taps and scrolls; a tool
  // using this content kind gets those through onScroll same as a text tool,
  // and a tap reaches it only via double-tap's own confirm-exit handling
  // (there is no onListSelect equivalent for a plain tap on an image page).
  imageSize?(): { width: number; height: number }

  // A list item was tapped while this tool owns the content area (only
  // relevant when contentKind() is 'list'). Called BEFORE the shell rebuilds,
  // so the tool should update whatever internal state contentKind, listItems
  // and initialContent will read on the rebuild this triggers.
  onListSelect?(index: number): void

  // The wearer confirmed leaving (chose Yes on the leave prompt). Return
  // 'tool' to rebuild this same tool again rather than exiting to the
  // launcher menu, which only makes sense for a tool that has its own
  // internal depth to step back through first: Teleprompter uses this to
  // return to its own script picker rather than leaving itself entirely, so
  // double-tap from a script backs up one level, matching what "back" means
  // everywhere else in this app. Called BEFORE the shell rebuilds, same as
  // onListSelect, so the tool should update its own state first (Teleprompter
  // resets its mode to 'list' here).
  //
  // Omitted, or returning 'menu', means what every tool before this one did:
  // leave to the launcher.
  onConfirmedExit?(): 'menu' | 'tool'

  // The page is now on screen. Start subscriptions and timers here rather than in
  // initialContent, because anything that updates the content area needs the
  // container to exist first.
  onOpen?(): void

  // A rebuild the tool itself triggered (onListSelect, or onConfirmedExit
  // returning 'tool') has landed and the new containers exist. Unlike
  // onOpen, the shell calls this after EVERY such internal rebuild, not only
  // the first time the tool is opened - needed by a tool whose new depth
  // requires the container to already exist before it can act, which is
  // only 'image' content today (pixels can only be sent to a container
  // already on screen, see Tool.imageSize). Most tools never need this:
  // Notes, Teleprompter and Weather all read already-loaded state
  // synchronously through listItems()/initialContent() on the same rebuild,
  // with nothing left to do once it lands.
  onContentReady?(): void

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

  // Long press while this tool is showing. Free for a tool to claim: per the
  // gesture rules, tap is always forward and double tap is always back, so
  // long press is the one gesture left for an action that is neither -
  // Notes uses it to reset a checklist's done state, which is not navigation
  // in either direction. Unassigned until a tool needs it; most never will.
  onLongPress?(): void
}
