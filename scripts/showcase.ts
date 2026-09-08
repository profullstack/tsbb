/**
 * Frames for the hqtui.com apps showcase.
 *
 * hqtui.com/apps captures screenshots of applications built on the library. The
 * capture script takes an application directory and imports this file, because
 * only the application knows what a good state looks like.
 *
 * A fixture rather than a live board: the test suite already drives the client
 * against a real server, and a screenshot needs the opposite property. It has
 * to be the same on every capture, or the image churns in every diff and
 * nobody can review what actually changed.
 *
 * Built from the real exported types with no casts, so this stops compiling if
 * the view model moves underneath it.
 */
import type { ForumNode, TopicSummary } from '@tsbb/client';
import { initialState, type State } from '../apps/tui/src/state.ts';
import { renderApp } from '../apps/tui/src/views.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-08T15:00:00.000Z');

const forum = (
  id: number,
  slug: string,
  name: string,
  description: string,
  topics: number,
  posts: number,
): ForumNode => ({
  id,
  slug,
  name,
  kind: 'forum',
  description,
  topics,
  posts,
  children: [],
});

const topic = (
  id: number,
  title: string,
  author: string,
  replies: number,
  views: number,
  ageDays: number,
  over: Partial<TopicSummary> = {},
): TopicSummary => ({
  id,
  slug: `t${id}`,
  title,
  kind: 'topic',
  locked: false,
  solved: false,
  replies,
  views,
  createdAt: NOW - ageDays * DAY,
  lastPostAt: NOW - Math.floor(ageDays * DAY * 0.4),
  author,
  lastPoster: author,
  unread: false,
  url: `/t/${id}`,
  ...over,
});

const FORUMS: ForumNode[] = [
  forum(1, 'announcements', 'Announcements', 'Releases and breaking changes', 14, 92),
  forum(2, 'help', 'Help & Support', 'Questions about using hqtui', 186, 1043),
  forum(3, 'showcase', 'Showcase', 'What you built with it', 47, 312),
  forum(4, 'ports', 'Language Ports', 'Rust, Go, Python, Zig, C++, COBOL', 63, 508),
  forum(5, 'meta', 'Meta', 'About the board itself', 9, 41),
];

const TOPICS: TopicSummary[] = [
  topic(101, '0.3.0: styled text spans', 'anthony', 12, 840, 0.2, { unread: true }),
  topic(102, 'Braille glyphs render wide in headless Chrome', 'anthony', 6, 219, 1.1, { solved: true }),
  topic(103, 'Collapsed borders across the language ports', 'kai', 23, 1102, 2.4),
  topic(104, 'Anyone using hqtui for a TUI file manager?', 'rin', 31, 1876, 4.0),
  topic(105, 'RFC: inline viewports and insertBefore', 'anthony', 18, 964, 5.5),
  topic(106, 'Zig 0.16 removed getenv — port build broken', 'mara', 9, 402, 7.2, { locked: true }),
  topic(107, 'Show: a REST client whose requests are files', 'anthony', 27, 2301, 9.8),
];

const STATE: State = {
  ...initialState('https://bbs.hqtui.com'),
  boardName: 'hqtui bbs',
  me: { authenticated: true, user: { id: 1, username: 'anthony', displayName: 'Anthony', postCount: 412 }, unread: 3 },
  screen: 'topics',
  forums: FORUMS.map((node) => ({ node, depth: 0 })),
  topics: TOPICS,
  forumName: 'Help & Support',
  forumSlug: 'help',
  selected: 2,
  status: '7 topics · 186 in this forum',
};

const WIDTH = 118;
const HEIGHT = 30;

export const frames = [
  {
    name: 'tsbb',
    width: WIDTH,
    height: HEIGHT,
    draw: ({ ui, height }: { ui: Parameters<typeof renderApp>[0]; height: number }) => {
      renderApp(ui, STATE, WIDTH, height);
    },
  },
];
