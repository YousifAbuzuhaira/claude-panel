// The pages /learn, /games and the pane open, in one list: what each is called and the
// Windows program behind it on WSL: a WPF game window, or Learn.ps1, the launcher that opens Learn
// in an Edge app window (none for the games page, which is a web page alone).
// Adding a game is one line here. Pure helpers only: the calls on `$` live in register.tsx.

const LEARN_PAGE = { id: 'learn', label: 'Learn', script: 'Learn.ps1' } as const

export const PAGES = [
  LEARN_PAGE,
  // An explainer's clips: Learn.ps1 -Explain opens the player in an Edge app window.
  { id: 'learn/video', label: 'the clips', script: 'Learn.ps1' },
  { id: 'games', label: 'the games', script: null },
  { id: 'games/sudoku', label: 'Sudoku', script: 'Sudoku.ps1' },
  { id: 'games/2048', label: '2048', script: 'Game2048.ps1' },
  { id: 'games/typing', label: 'Typing', script: 'TypeTest.ps1' },
  { id: 'games/chess', label: 'Chess', script: 'ChessPuzzles.ps1' },
] as const

type Page = (typeof PAGES)[number]
type GamePage = Extract<Page, { id: `games/${string}` }>

export type GameId = GamePage['id'] extends `games/${infer Name}` ? Name : never

const GAME_PREFIX = 'games/'

/** The games, in the order the pane's games row and /games list them. */
export const GAMES: readonly { id: GameId; label: string }[] = PAGES.filter((page): page is GamePage =>
  page.id.startsWith(GAME_PREFIX),
).map(page => ({ id: page.id.slice(GAME_PREFIX.length) as GameId, label: page.label }))

/** Learn's launcher on WSL (Learn.ps1): the one script that takes a view and a course. */
export const LEARN_SCRIPT = LEARN_PAGE.script

export const isGame = (name: string): name is GameId => GAMES.some(game => game.id === name)

/** What a page is called in a message: `learn`, `games` (the games page) or `games/<id>`. */
export function pageLabel(page: string): string {
  return PAGES.find(one => one.id === page)?.label ?? page
}

/**
 * The message for a page that opens: a course by its title, Learn at a view, or the
 * page by name. `isWindow`: it opened in its own window (macOS), else it is opening (WSL).
 */
export function openingText(page: string, deep: { view?: string; courseTitle?: string }, isWindow: boolean): string {
  const course = page === 'learn' ? deep.courseTitle : undefined
  if (course) return isWindow ? `Opened ${course} in Learn's window.` : `Opening ${course} in Learn.`
  const name = `${pageLabel(page)}${deep.view ? ` (${deep.view})` : ''}`
  return isWindow ? `Opened ${name} in its own window.` : `Opening ${name}.`
}

/** The Windows script behind a page on WSL, or undefined where it has none (the games page). */
export function windowScript(page: string): string | undefined {
  return PAGES.find(one => one.id === page)?.script ?? undefined
}
