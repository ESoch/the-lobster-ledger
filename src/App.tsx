import { Fragment, useEffect, useRef, useState } from 'react';
import {
  House,
  BookOpen,
  Scale,
  Trophy,
  MapPin,
  Users,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Bell,
  Search,
  Download,
  Menu,
  X,
  ShieldCheck,
  Check,
  Copy,
  MessageSquare,
  Share2,
  LogOut,
  Link2,
  CircleHelp,
  Compass,
  History,
  Moon,
  RotateCcw,
  Sun,
  Terminal,
  Plug,
  ChartLine,
  UserRoundPen,
} from 'lucide-react';
import type { Bet, BetAction, NewBet, PriceCorrectionInput, PriceReportInput } from './lib/types';
import { useLedger } from './lib/useLedger';
import { useBackDismiss } from './lib/useBackDismiss';
import { needsAction } from './lib/ledger';
import { api, ApiError } from './lib/client';
import { demoStorageKey } from './lib/client-state';
import { downloadFile, exportCsv, exportFilename, exportJson, exportPricesCsv } from './lib/export';
import { STORAGE_FULL_WARNING } from './lib/client-state';
import { forgetSession } from './lib/session-hint';
import {
  actionToast,
  archiveExportToast,
  BET_NOT_FOUND_TOAST,
  betCreatedToast,
  exportToast,
  pricesExportToast,
  memberSwitchedToast,
  offsetToast,
  priceAlreadyRecordedToast,
  priceCorrectedToast,
  priceSavedToast,
  priceWithdrawnToast,
  SIGN_OUT_FAILED_TOAST,
} from './lib/toast-copy';
import { RULES } from './lib/rules-copy';
import { LIMITS } from './lib/limits';
import { MEMBER_NAME_BLANK, memberNameProblem, normalizeMemberName } from './lib/member-name';
import { LobsterMark, RollIllustration } from './components/Brand';
import {
  Avatar,
  Modal,
  currentOpener,
  focusPageHeading,
  rememberDialogOpener,
  type LeaveRequest,
} from './components/ui';
import { ToastRegion, useToast } from './components/Toast';
import { NewBetDialog } from './components/NewBetDialog';
import { BetDetail } from './components/BetDetail';
import {
  FieldError,
  FieldErrorsProvider,
  findProblems,
  useFieldErrors,
} from './components/form-errors';
import { MemberSwitcher } from './components/MemberSwitcher';
import { AccountMenu, type AccountMenuItem } from './components/AccountMenu';
import { ProfileDialog } from './components/ProfileDialog';
import { CliAuthorization, CliGuide } from './components/CliAccess';
import { McpGuide } from './components/McpAccess';
import { captureCliRequest, cleanCliRequestUrl } from './components/cli-request';
import {
  BET_LINK_INVALID_MESSAGE,
  captureBetLinkAttempt,
  consumeBetLink,
  findLinkedBet,
} from './components/cli-bet-link';
import { ConnectionNotice } from './components/ConnectionNotice';
import { GoogleMark } from './components/GoogleMark';
import { LoadingScreen } from './components/LoadingScreen';
import { cliApi } from './components/cli-api';
import { LobsterPrices } from './components/LobsterPrices';
import { plural } from './lib/plural';
import { PendingInvitations } from './components/PendingInvitations';
import {
  Overview,
  LedgerView,
  BalancesView,
  LeaderboardView,
  PlacesView,
  MembersView,
  InboxView,
} from './components/LedgerViews';

// Every route, in sidebar order. The navigation, breadcrumb, document title and hash parsing all
// read this one list; `secondary` entries sit below the divider.
const pages = [
  { id: 'overview', label: 'Overview', icon: House },
  { id: 'ledger', label: 'The ledger', icon: BookOpen },
  { id: 'balances', label: 'Balances', icon: Scale },
  { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
  { id: 'places', label: 'Places', icon: MapPin },
  { id: 'lobster-prices', label: 'Lobster prices', icon: ChartLine },
  { id: 'members', label: 'Members', icon: Users, secondary: true },
  { id: 'inbox', label: 'Activity inbox', icon: Bell, secondary: true },
  { id: 'cli', label: 'Command line', icon: Terminal, secondary: true },
  { id: 'mcp', label: 'AI connections', icon: Plug, secondary: true },
];
const siteName = 'The Lobster Ledger';
const pageCopy: Record<string, { title: string; description: string }> = {
  'lobster-prices': {
    title: 'Lobster, by the pound.',
    description: 'What Maine harvesters were paid per pound of live lobster.',
  },
  ledger: {
    title: 'The ledger.',
    description: 'Every wager, every handshake, every lobster roll.',
  },
  balances: {
    title: 'Who’s buying lunch?',
    description: 'A clear account of what’s owed, and to whom.',
  },
  leaderboard: {
    title: 'The leaderboard.',
    description: 'A little friendly competition. A very official record.',
  },
  places: {
    title: 'A map of good stories.',
    description: 'The places where opinions became lobster rolls.',
  },
  members: {
    title: 'The people at the table.',
    description: 'Your circle of friendly competitors.',
  },
  inbox: {
    title: 'Your activity inbox.',
    description: 'New handshakes, settled scores, and everything in between.',
  },
};
// Addresses that open a view inside a page: #places/prices is Places on its Roll prices tab.
const subRoutes: Record<string, string> = { 'places/prices': 'places' };
/** The page an address (a hash without its #) belongs to. */
const pageOf = (value: string) => subRoutes[value] ?? value;
/** A page's address, or one inside a page such as places/prices. */
const isAddress = (value: string | null) => pages.some((page) => page.id === pageOf(value ?? ''));
/** The address that reopens `page` as it is: the one in the bar when it is this page's, tab and all. */
function addressOf(page: string) {
  const value = window.location.hash.slice(1);
  return pageOf(value) === page ? value : page;
}
function currentPage() {
  const value = pageOf(window.location.hash.slice(1));
  return pages.some((page) => page.id === value) ? value : 'overview';
}
// The browser chrome (address bar, status bar) takes its colour from the page background.
const themeKey = 'lobster-ledger-theme';
const themeColours = { dark: '#101b1d', light: '#f7f8f5' };
// What the reader chose with the toggle. Nothing is stored until they do.
function savedTheme(): 'light' | 'dark' | null {
  try {
    const value = window.localStorage.getItem(themeKey);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}
// Dark is the house default; it gives way only to a stored choice or an explicit light OS setting.
const systemTheme = () =>
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
// Sign-in leaves the page and comes back to the bare address, so the page a visitor was heading for
// waits here in the meantime. The two public guides always return; any other page returns only to a
// bare address, so it can never override one that names a page, and never inside the demo, whose
// visit leaves it waiting for the real ledger, as it does a bet link.
const RETURN_PAGE_KEY = 'lobster-ledger-return-page';
function returnPage(demo: boolean): string | undefined {
  try {
    const value = window.sessionStorage.getItem(RETURN_PAGE_KEY);
    if (value === 'cli' || value === 'mcp') return value;
    // An address inside a page (#places/prices) comes back as that address.
    if (!demo && !window.location.hash && isAddress(value)) return value ?? undefined;
  } catch {
    // Public navigation remains usable when storage is unavailable.
  }
}

export default function App() {
  const ledger = useLedger();
  const { state, member, memberId, demo } = ledger;
  const [cliRequest, setCliRequest] = useState(() => captureCliRequest(demo));
  const [betLink] = useState(() => captureBetLinkAttempt(demo));
  const [linkedBet, setLinkedBet] = useState(betLink.betId);
  // The link that was followed named no bet at all; whichever page comes first says so, once.
  const [linkInvalid, setLinkInvalid] = useState(betLink.invalid);
  const [page, setPage] = useState(() => {
    if (cliRequest.pending || cliRequest.error) return 'cli';
    const saved = returnPage(demo);
    return saved ? pageOf(saved) : currentPage();
  });
  // The page the screen is showing, readable from event handlers that fire before React re-renders.
  const pageRef = useRef(page);
  const shownPage = useRef(page);
  function showPage(next: string) {
    pageRef.current = next;
    setPage(next);
  }
  const [mobileNav, setMobileNav] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width:760px)').matches);
  const sidebarRef = useRef<HTMLElement>(null);
  // `search` is the ledger page's filter. The topbar field only collects a draft until Enter.
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [newBet, setNewBet] = useState(false);
  const [newBetMode, setNewBetMode] = useState<'new' | 'history'>('new');
  const [newBetPlace, setNewBetPlace] = useState<string>();
  const [newBetOpponent, setNewBetOpponent] = useState<string>();
  const [now, setNow] = useState(() => new Date().toISOString());
  const [selectedId, setSelectedId] = useState<string>();
  const { toast, show: showToast, dismiss: dismissToast } = useToast();
  const [invite, setInvite] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const inviteFields = useFieldErrors();
  // The name field, for a refusal from the server: the name is the only thing the form sends.
  const inviteNameField = useRef<HTMLInputElement>(null);
  // The form is replaced by the ready message, so the button that was pressed is gone: focus moves to
  // that message, which a screen reader then reads.
  const inviteReady = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (inviteLink) inviteReady.current?.focus();
  }, [inviteLink]);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => (savedTheme() ?? systemTheme()) === 'dark');
  useEffect(() => {
    cleanCliRequestUrl(cliRequest);
  }, [cliRequest]);
  useEffect(() => {
    try {
      const target = returnPage(demo);
      const saved = window.sessionStorage.getItem(RETURN_PAGE_KEY);
      // Whatever was saved has been used or is not a page, so it must not come back on a later
      // visit. Only a page waiting out a demo visit stays.
      if (!demo || saved === 'cli' || saved === 'mcp' || !isAddress(saved))
        window.sessionStorage.removeItem(RETURN_PAGE_KEY);
      if (target && !cliRequest.pending && !cliRequest.error) window.location.hash = target;
    } catch {
      // Sign-in still works without a stored return route.
    }
  }, []);
  useEffect(() => {
    if (!state || !member || !linkedBet || cliRequest.pending || cliRequest.error) return;
    const found = findLinkedBet(state.bets, linkedBet);
    // The link is used up here: it leaves the saved copy and the address bar, which now reads
    // #ledger, so a reload shows the ledger instead of opening the sheet again. A demo link was
    // never saved, and the copy saved for the real ledger is not its to take.
    consumeBetLink(demo);
    showPage('ledger');
    if (found) setSelectedId(found.id);
    else showToast(BET_NOT_FOUND_TOAST, 'error');
    setLinkedBet(undefined);
  }, [demo, state, member, linkedBet, cliRequest]);
  useEffect(() => {
    if (!linkInvalid || !state || !member) return;
    showToast(BET_LINK_INVALID_MESSAGE, 'error');
    setLinkInvalid(false);
  }, [linkInvalid, state, member]);
  useEffect(() => {
    const theme = darkMode ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', themeColours[theme]);
  }, [darkMode]);
  useEffect(() => {
    // Until the reader picks a theme with the toggle, the page follows the operating system.
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const follow = () => {
      if (!savedTheme()) setDarkMode(!query.matches);
    };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    try {
      window.localStorage.setItem(themeKey, next ? 'dark' : 'light');
    } catch {
      // The theme still applies when storage is unavailable.
    }
  }
  useEffect(() => {
    // The ledger page keeps its own filter, so a term does not outlive the page it was typed for.
    if (page !== 'ledger') setSearch('');
  }, [page]);
  useEffect(() => {
    const update = () => setNow(new Date().toISOString());
    const interval = window.setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    const change = () => {
      const next = currentPage();
      if (next === pageRef.current) return;
      // Back/Forward (or a typed hash) leaves the page the open bet sheet belonged to.
      setSelectedId(undefined);
      showPage(next);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width:760px)');
    const update = () => setIsMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!isMobile || !mobileNav) return;
    const previous = currentOpener();
    // A dialog launched from the drawer gives focus back to the menu button once the drawer is gone.
    rememberDialogOpener(sidebarRef.current, previous);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const buttons = () =>
      Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),select',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    sidebarRef.current?.querySelector<HTMLElement>('.mobile-close')?.focus();
    const keydown = (event: KeyboardEvent) => {
      // A dialog opened over the drawer owns Escape; the drawer must not close behind it.
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"][data-state="open"]'))
        setMobileNav(false);
      if (event.key === 'Tab') {
        const items = buttons();
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keydown);
      // The menu button is hidden once the window is wide, so the page heading takes focus instead.
      const phone = window.matchMedia('(max-width:760px)').matches;
      if (phone) previous?.focus();
      if (
        (!phone || document.activeElement === document.body) &&
        !document.querySelector('[role="dialog"][data-state="open"]')
      )
        focusPageHeading();
    };
  }, [isMobile, mobileNav]);
  useEffect(() => {
    if (!isMobile) setMobileNav(false);
  }, [isMobile]);
  // Try again swaps the page for the opening screen, which takes focus with it. When the load ends,
  // the heading of whatever follows (the ledger, or the same failure again) gets focus back.
  const retried = useRef(false);
  const tryAgain = () => {
    retried.current = true;
    ledger.retry();
  };
  useEffect(() => {
    if (ledger.loading || !retried.current) return;
    retried.current = false;
    focusPageHeading();
  }, [ledger.loading]);
  const signedIn = !!state && !!member;
  const publicGuide = (page === 'cli' || page === 'mcp') && !signedIn;
  // Signed in, but the ledger did not open: a connection problem, not a reason to sign in again.
  const ledgerUnavailable = !state && !!member && ledger.loadFailed;
  // Unknown is not "not set up": sign-in stays usable while the check runs or when it got no answer.
  const signInAvailable =
    ledger.loading || ledger.configStatus === 'unreachable' || ledger.configured;
  const connectionLost = ledger.configStatus === 'unreachable' || ledger.loadFailed;
  // A signed-out visitor who followed a link to a page of the ledger (not the front page, and not
  // while a bet link is already waiting): the welcome page says what signing in will open.
  const waitingFor =
    !linkedBet && page !== 'overview' ? pages.find((item) => item.id === page)?.label : undefined;
  const pageLabel =
    signedIn || publicGuide
      ? pages.find((item) => item.id === page)?.label
      : ledger.loading
        ? undefined
        : ledgerUnavailable
          ? 'Can’t reach the ledger'
          : 'Welcome';
  useEffect(() => {
    if (pageLabel) document.title = `${pageLabel} · ${siteName}`;
  }, [pageLabel]);
  useEffect(() => {
    // Covers every route change, including raw #hash links and Back/Forward, not just navigate().
    if (shownPage.current === page) return;
    shownPage.current = page;
    window.scrollTo({ top: 0 });
    const active = document.activeElement;
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement;
    if (!typing && !document.querySelector('[role="dialog"][data-state="open"]'))
      focusPageHeading();
  }, [page]);
  function navigate(next: string) {
    if (pageOf(next) === pageRef.current) window.scrollTo({ top: 0 });
    window.location.hash = next;
    showPage(pageOf(next));
    setMobileNav(false);
  }
  const selected = state?.bets.find((bet) => bet.id === selectedId);
  // The open sheet's way out for Back, a typed #hash or a link: it asks first about a typed draft.
  const sheetLeave = useRef<LeaveRequest | null>(null);
  useBackDismiss(!!selected, () => setSelectedId(undefined), sheetLeave);
  const approvals = state?.bets.filter((bet) => needsAction(bet, memberId, now)).length ?? 0;
  const nameOf = (id: string) =>
    state?.members.find((item) => item.id === id)?.name ?? 'the other person';
  const restaurantName = (id: string) =>
    state?.restaurants?.find((item) => item.id === id)?.name ?? 'the restaurant';
  // The bet just proposed, whose sheet opens at its next step. Forgotten once that sheet closes.
  const [proposedId, setProposedId] = useState<string>();
  if (proposedId && proposedId !== selectedId) setProposedId(undefined);
  async function create(input: NewBet) {
    const bet = await ledger.addBet(input);
    setSelectedId(bet.id);
    setProposedId(bet.id);
    showToast(betCreatedToast(nameOf(input.opponentId), !!input.history));
  }
  /** Saves a price (and its new restaurant, in the same write) and says where it went. */
  async function savePrice(input: PriceReportInput): Promise<string> {
    const { observation, restaurant, duplicateOf } = await ledger.addPriceObservation(input);
    showToast(
      duplicateOf
        ? priceAlreadyRecordedToast(observation.priceCents, restaurant.name)
        : priceSavedToast(observation.priceCents, restaurant.name),
    );
    return restaurant.id;
  }
  async function correctPrice(id: string, input: PriceCorrectionInput) {
    await ledger.correctPriceObservation(id, input);
    showToast(priceCorrectedToast(input.priceCents, restaurantName(input.restaurantId)));
  }
  async function withdrawPrice(id: string, reason: string) {
    const { observation } = await ledger.withdrawPriceObservation(id, reason);
    showToast(
      priceWithdrawnToast(observation.priceCents, restaurantName(observation.restaurantId)),
    );
  }
  async function act(bet: Bet, action: BetAction) {
    await ledger.act(bet, action);
    showToast(actionToast({ bet, action, members: state?.members ?? [], actorId: memberId }));
  }
  function openNewBet() {
    setNewBetMode('new');
    setNewBet(true);
  }
  function openInvite() {
    setMobileNav(false);
    setInvite(true);
    setInviteName('');
    setInviteLink('');
    setInviteError('');
    inviteFields.clearAll();
  }
  async function createInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteBusy) return;
    setInviteError('');
    const form = event.currentTarget;
    // The ledger's rule for a member's name, including a name already at the table, is checked
    // with the field's own limits and shown on the field the same way.
    const nameProblem = memberNameProblem(inviteName, state?.members);
    const nameElement = form.elements.namedItem('name');
    const extra =
      nameProblem && nameElement instanceof HTMLInputElement
        ? [{ name: 'name', message: nameProblem, element: nameElement }]
        : [];
    if (inviteFields.show(findProblems(form, extra))) return;
    // The name is kept as it will appear: trimmed, with one space between words.
    const name = normalizeMemberName(inviteName);
    setInviteName(name);
    setInviteBusy(true);
    try {
      if (demo) {
        const added = await ledger.addDemoMember(name);
        showToast(`${added.name} added to the demo. You can now make a bet with them.`);
        setInvite(false);
      } else {
        const result = await api.invite(name);
        setInviteLink(result.url);
      }
    } catch (reason) {
      const field = inviteNameField.current;
      if (reason instanceof ApiError && reason.status === 400 && field?.isConnected) {
        // The name is the only thing the form sends, so a refusal is about it; the form only knows the
        // members it has loaded, and the ledger may know one more.
        inviteFields.show([{ name: 'name', message: reason.message, element: field }]);
      } else
        setInviteError(
          reason instanceof Error ? reason.message : 'Unable to create the invitation.',
        );
    } finally {
      setInviteBusy(false);
    }
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      showToast('Invitation link copied.');
    } catch {
      setInviteError('Select and copy the invitation link below.');
    }
  }
  const shareText = `You’re invited to The Lobster Ledger. Join our table and put your next lobster-roll bet on the record: ${inviteLink}`;
  const signInForGuide = (guide: 'cli' | 'mcp') => {
    if (!signInAvailable) return;
    try {
      window.sessionStorage.setItem(RETURN_PAGE_KEY, guide);
    } catch {
      // The current authorization request reports unavailable storage separately.
    }
    window.location.assign('/auth/google');
  };
  // An unconfigured ledger says sign-in isn't set up; a failed config check must not claim that.
  const signInUnavailableReason = ledger.error
    ? 'Sign-in can’t be reached right now. Try again shortly.'
    : undefined;
  const cliContent = (
    <>
      <CliGuide
        origin={window.location.origin}
        signedIn={!!member}
        demo={demo}
        request={cliApi}
        onSignIn={() => signInForGuide('cli')}
        signInAvailable={signInAvailable}
        signInUnavailableReason={signInUnavailableReason}
        authorization={
          cliRequest.pending || cliRequest.error ? (
            <CliAuthorization
              origin={window.location.origin}
              requestState={cliRequest}
              memberName={member?.name}
              demo={demo}
              onSignIn={() => signInForGuide('cli')}
              signInAvailable={signInAvailable}
              signInUnavailableReason={signInUnavailableReason}
              onDismiss={() => setCliRequest({})}
              request={cliApi}
            />
          ) : undefined
        }
      />
    </>
  );
  const mcpContent = (
    <McpGuide
      origin={window.location.origin}
      signedIn={!!member}
      demo={demo}
      onSignIn={() => signInForGuide('mcp')}
      signInAvailable={signInAvailable}
      signInUnavailableReason={signInUnavailableReason}
    />
  );
  if ((page === 'cli' || page === 'mcp') && (!state || !member))
    return (
      <div className="cli-public">
        <header className="cli-public-header">
          <a className="cli-public-brand" href="#overview" onClick={() => navigate('overview')}>
            <LobsterMark size={34} />
            <strong>the lobster ledger</strong>
          </a>
          <a className="cli-public-link" href="#overview" onClick={() => navigate('overview')}>
            <span aria-hidden="true">←</span> Back to sign in
          </a>
        </header>
        <main>
          {/* Nothing is shown while the check runs: a notice that appears and goes would push the
              guide down and back up, and the sign-in buttons already work in the meantime. */}
          {connectionLost ? (
            <ConnectionNotice actions={[{ label: 'Try again', onClick: tryAgain }]}>
              Can’t reach the ledger right now. You can keep reading this guide; try again when
              you’re ready.
            </ConnectionNotice>
          ) : !signInAvailable ? (
            // Neither guide repeats this in its own words, so this one notice serves both.
            <ConnectionNotice tone="info">
              You can read this guide, but connecting an account has to wait: an administrator still
              needs to turn on Google sign-in for this ledger.
            </ConnectionNotice>
          ) : null}
          {page === 'mcp' ? mcpContent : cliContent}
        </main>
      </div>
    );
  if (ledger.loading) return <LoadingScreen onRetry={tryAgain} />;
  if (ledgerUnavailable)
    return (
      <div className="welcome-screen">
        <header>
          <LobsterMark size={34} />
          <strong>the lobster ledger</strong>
        </header>
        <main>
          <span className="welcome-emblem">
            <LobsterMark size={66} />
          </span>
          <h1>Can’t reach the ledger.</h1>
          <p>
            You’re signed in as {member.name}, but the ledger didn’t open. Nothing on the record has
            changed. Check your connection and try again.
          </p>
          <button className="button button-primary" type="button" onClick={tryAgain}>
            Try again
          </button>
          <div className="welcome-links">
            <a className="welcome-cli-link" href="#cli" onClick={() => navigate('cli')}>
              <Terminal size={16} />
              Install the command-line app
            </a>
            <a className="welcome-cli-link" href="#mcp" onClick={() => navigate('mcp')}>
              <Plug size={16} />
              Connect Claude or Codex
            </a>
          </div>
        </main>
        <RollIllustration className="welcome-roll" />
      </div>
    );
  if (!state || !member)
    return (
      <div className="welcome-screen">
        <header>
          <LobsterMark size={34} />
          <strong>the lobster ledger</strong>
        </header>
        <main>
          <span className="welcome-emblem">
            <LobsterMark size={66} />
          </span>
          <h1>
            Friendly wagers.
            <br />
            Properly kept.
          </h1>
          <p>Clear terms. A mutual handshake. Every lobster roll accounted for.</p>
          {(linkedBet || waitingFor) && (
            <div className="welcome-pending-bet">
              <Link2 size={16} aria-hidden="true" />
              <span>
                {linkedBet
                  ? 'Sign in to open the bet you were sent'
                  : `Sign in to open ${waitingFor!.replace(/^The /, 'the ')}`}
              </span>
            </div>
          )}
          {linkInvalid && (
            <ConnectionNotice
              tone="info"
              actions={[
                {
                  label: 'Dismiss',
                  onClick: () => {
                    setLinkInvalid(false);
                    // The button that was pressed goes with the notice; the page heading takes focus.
                    focusPageHeading();
                  },
                },
              ]}
            >
              {BET_LINK_INVALID_MESSAGE}
            </ConnectionNotice>
          )}
          <a
            className="button button-primary"
            href="/auth/google"
            aria-disabled={!signInAvailable}
            onClick={(event) => {
              if (!signInAvailable) return event.preventDefault();
              try {
                // Sign-in returns to the bare address; a bet link already has its own way back.
                if (waitingFor) window.sessionStorage.setItem(RETURN_PAGE_KEY, addressOf(page));
              } catch {
                // Signing in still works; the visitor just lands on the Overview.
              }
            }}
          >
            <GoogleMark />
            Continue with Google
            <ArrowRight size={16} />
          </a>
          {connectionLost ? (
            <ConnectionNotice actions={[{ label: 'Try again', onClick: tryAgain }]}>
              Can’t reach the ledger right now. Check your connection and try again.
            </ConnectionNotice>
          ) : !signInAvailable ? (
            <ConnectionNotice tone="info">
              The private workspace needs its Google sign-in connected before members can join.
            </ConnectionNotice>
          ) : ledger.sessionEnded ? (
            <ConnectionNotice tone="info">
              Your session ended, so you’re signed out. Continue with Google to pick up where you
              left off.
            </ConnectionNotice>
          ) : null}
          {/* With Google switched off the demo is the one thing here that works, so it leads. */}
          <a
            className={`button ${signInAvailable ? 'button-secondary' : 'button-primary'}`}
            href="/?demo=1"
          >
            Explore the interactive demo
            <Compass size={16} />
          </a>
          <div className="welcome-links">
            <a className="welcome-cli-link" href="#cli" onClick={() => navigate('cli')}>
              <Terminal size={16} />
              Install the command-line app
            </a>
            <a className="welcome-cli-link" href="#mcp" onClick={() => navigate('mcp')}>
              <Plug size={16} />
              Connect Claude or Codex
            </a>
          </div>
          <div className="welcome-trust">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Private membership. Mutual approvals. A complete history.</span>
          </div>
        </main>
        <RollIllustration className="welcome-roll" />
      </div>
    );
  const firstName = member.name.split(' ')[0];
  const hour = new Date().getHours();
  // Morning starts at 5: the small hours are still the evening before, not a good morning.
  const greeting =
    hour >= 5 && hour < 12
      ? 'Good morning'
      : hour >= 12 && hour < 17
        ? 'Good afternoon'
        : 'Good evening';
  // The phone drawer is a modal dialog; the desktop sidebar is a labelled complementary landmark.
  // The cast keeps the aside typing for the shared ref and props, the tag differs at runtime.
  const Sidebar = (isMobile ? 'div' : 'aside') as 'aside';
  function signOut() {
    void api
      .logout()
      .then(() => {
        // Signed out on purpose, so the next visit is not told a session ended.
        forgetSession();
        window.location.assign('/');
      })
      .catch(() => showToast(SIGN_OUT_FAILED_TOAST, 'error'));
  }
  // Leaving is a plain page load: the welcome page offers the demo again, and the demo ledger stays.
  function exitDemo() {
    window.location.assign('/');
  }
  // The demo keeps its sample ledger in this browser under a key per demoSession; dropping that key
  // and reloading gives back the stock sample bets. The theme choice is not part of the demo.
  function resetDemo() {
    try {
      window.localStorage.removeItem(demoStorageKey(window.location.search));
    } catch {
      // Without storage the demo only ever lasted for this visit, so the reload alone resets it.
    }
    window.location.reload();
  }
  const accountItems: AccountMenuItem[] = [
    {
      key: 'profile',
      label: 'Edit profile',
      icon: <UserRoundPen size={17} aria-hidden="true" />,
      onSelect: () => setProfileOpen(true),
    },
    {
      key: 'members',
      label: 'Members',
      icon: <Users size={17} aria-hidden="true" />,
      onSelect: () => navigate('members'),
    },
    {
      key: 'cli',
      label: 'Command line',
      icon: <Terminal size={17} aria-hidden="true" />,
      onSelect: () => navigate('cli'),
    },
    ...(demo
      ? [
          {
            key: 'reset',
            label: 'Reset demo',
            icon: <RotateCcw size={17} aria-hidden="true" />,
            onSelect: () => setResetOpen(true),
            separated: true,
          },
          {
            key: 'exit',
            label: 'Exit demo',
            icon: <LogOut size={17} aria-hidden="true" />,
            onSelect: exitDemo,
          },
        ]
      : [
          {
            key: 'signout',
            label: 'Sign out',
            icon: <LogOut size={17} aria-hidden="true" />,
            onSelect: signOut,
            separated: true,
          },
        ]),
  ];
  return (
    <div className="app-shell">
      <button
        type="button"
        className="skip-link"
        onClick={() => document.getElementById('main')?.focus()}
      >
        Skip to content
      </button>
      {mobileNav && (
        // A pointer-only scrim: the Close navigation button inside the drawer and Escape are the
        // keyboard routes, so this adds no second control to the tab order or the accessibility tree.
        <div
          className="mobile-nav-backdrop"
          aria-hidden="true"
          onClick={() => setMobileNav(false)}
        />
      )}
      <Sidebar
        ref={sidebarRef}
        inert={isMobile && !mobileNav}
        aria-hidden={isMobile && !mobileNav ? true : undefined}
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile && mobileNav ? true : undefined}
        aria-label={isMobile ? 'Workspace navigation' : 'Workspace'}
        className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}
      >
        <a className="brand" href="#overview" onClick={() => navigate('overview')}>
          <LobsterMark size={38} />
          <span>
            the lobster
            <br />
            <strong>ledger</strong>
          </span>
          <span className="brand-period">.</span>
        </a>
        <button
          className="mobile-close icon-button"
          onClick={() => setMobileNav(false)}
          aria-label="Close navigation"
        >
          <X size={19} />
        </button>
        {/* A heading for the workspace, not a switcher: there is one group, and Members lists it. */}
        <div className="workspace-switch">
          <span className="workspace-symbol" aria-hidden="true">
            {state.groupName.slice(0, 1)}
          </span>
          <span>
            <strong>{state.groupName}</strong>
            <small>
              {plural(state.members.length, 'member')}
              {demo ? ' · Demo workspace' : ' · Private workspace'}
            </small>
          </span>
        </div>
        <div className="nav-label">Workspace</div>
        <nav aria-label="Main navigation">
          {pages.map((item, index) => (
            <Fragment key={item.id}>
              {item.secondary && !pages[index - 1].secondary && <div className="nav-divider" />}
              <a
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                href={`#${item.id}`}
                onClick={() => navigate(item.id)}
                aria-current={page === item.id ? 'page' : undefined}
              >
                <item.icon size={19} />
                <span>{item.label}</span>
                {item.id === 'ledger' && (
                  <small>
                    {state.bets.length}
                    <span className="sr-only"> bets</span>
                  </small>
                )}
                {item.id === 'inbox' && approvals > 0 && (
                  <small className="nav-count">
                    {approvals}
                    <span className="sr-only"> waiting</span>
                  </small>
                )}
              </a>
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="house-rule">
            <span>
              <ShieldCheck size={20} />
              The house rule
            </span>
            <p>
              A bet takes two handshakes.
              <br />
              Every settlement stays on record.
            </p>
            <button
              onClick={() => {
                setMobileNav(false);
                setHelpOpen(true);
              }}
            >
              How it works
              <ArrowUpRight size={14} />
            </button>
          </div>
          {/* A short window shows only "Invite" (adjudication.css); the full name stays for screen
              readers and as a tooltip. The words share one element: the button is a flex row with
              a gap, and two flex items would sit a gap apart instead of a word space. */}
          <button className="invite-sidebar" title="Invite a member" onClick={openInvite}>
            <Users size={17} />
            <span className="invite-words">
              Invite<span className="invite-rest"> a member</span>
            </span>
            <Plus size={16} />
          </button>
          <div className="sidebar-profile">
            <Avatar member={member} size={35} decorative />
            <span>
              <strong>{member.name}</strong>
              <small>{demo ? 'Exploring the demo' : 'Ledger member'}</small>
            </span>
            <button
              className="icon-button"
              aria-label={demo ? 'Exit demo' : 'Sign out'}
              title={demo ? 'Exit demo' : 'Sign out'}
              onClick={demo ? exitDemo : signOut}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </Sidebar>
      <div className="main-shell" inert={isMobile && mobileNav}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
            >
              <Menu size={21} />
            </button>
            <strong>{pages.find((item) => item.id === page)?.label}</strong>
          </div>
          <div className="topbar-actions">
            {/* The ledger page has its own search field; two boxes for one filter would disagree. */}
            {page !== 'ledger' && (
              <div className="global-search" role="search">
                <Search size={16} aria-hidden="true" />
                <input
                  ref={searchInput}
                  placeholder="Find a bet…"
                  aria-label="Find a bet"
                  enterKeyHint="search"
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      const term = searchDraft.trim();
                      if (!term) return;
                      setSearch(term);
                      setSearchDraft('');
                      navigate('ledger');
                    } else if (event.key === 'Escape' && searchDraft) {
                      event.preventDefault();
                      setSearchDraft('');
                    }
                  }}
                />
                {searchDraft && (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchDraft('');
                      searchInput.current?.focus();
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            <button
              className="icon-button theme-toggle"
              onClick={toggleTheme}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <button
              className="icon-button notification-button"
              onClick={() => navigate('inbox')}
              aria-label={`Activity inbox, ${
                approvals === 0
                  ? 'nothing waiting'
                  : `${approvals} ${approvals === 1 ? 'action' : 'actions'} waiting`
              }`}
            >
              <Bell size={19} />
              {approvals > 0 && <i />}
            </button>
            <AccountMenu
              member={member}
              caption={demo ? 'Exploring the demo' : 'Ledger member'}
              items={accountItems}
            />
          </div>
        </header>
        {demo && (
          <section className="demo-bar" aria-label="Demo mode">
            <span>
              <span className="demo-dot" />
              <strong>Demo ledger</strong>
              <span className="demo-explainer">Sample bets. Changes stay in this browser.</span>
            </span>
            <MemberSwitcher
              members={state.members}
              memberId={memberId}
              onChange={(id) => {
                ledger.setMemberId(id);
                showToast(memberSwitchedToast(nameOf(id)));
              }}
            />
          </section>
        )}
        <main className="workspace" id="main" tabIndex={-1}>
          {!['cli', 'mcp'].includes(page) && (
            <div className="page-heading">
              <div>
                {page === 'overview' ? (
                  <>
                    <div className="date-eyebrow">
                      {new Date().toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </div>
                    <h1>
                      {greeting}, {firstName}.
                    </h1>
                    <p>A little friendly rivalry. Everything accounted for.</p>
                  </>
                ) : (
                  <>
                    <h1>{pageCopy[page]?.title}</h1>
                    <p>{pageCopy[page]?.description}</p>
                  </>
                )}
              </div>
              <div className="heading-actions">
                {page === 'ledger' && (
                  <button
                    className="button button-secondary export-button"
                    title="Export the ledger"
                    onClick={() => setExportOpen(true)}
                  >
                    <Download size={16} />
                    Export
                  </button>
                )}
                {['overview', 'ledger'].includes(page) && (
                  <button
                    className="button button-secondary history-entry-button"
                    onClick={() => {
                      setNewBetMode('history');
                      setNewBet(true);
                    }}
                  >
                    <History size={17} />
                    Add existing bet
                  </button>
                )}
                <button
                  className="button button-primary"
                  onClick={() => {
                    setNewBetMode('new');
                    setNewBet(true);
                  }}
                >
                  <Plus size={18} />
                  New bet
                </button>
              </div>
            </div>
          )}
          {ledger.storageWarning && (
            <ConnectionNotice
              actions={[
                // Only the warning that tells the member to export gets the button that does it.
                ...(ledger.storageWarning === STORAGE_FULL_WARNING
                  ? [{ label: 'Export', onClick: () => setExportOpen(true) }]
                  : []),
                {
                  label: 'Dismiss',
                  onClick: () => {
                    ledger.dismissStorageWarning();
                    // The button that was pressed goes with the notice; the page heading takes focus.
                    focusPageHeading();
                  },
                },
              ]}
            >
              {ledger.storageWarning}
            </ConnectionNotice>
          )}
          {ledger.sessionExpired ? (
            // Reconnecting cannot help once the session is gone, so the way back in takes its place.
            <ConnectionNotice
              tone="info"
              actions={[
                {
                  label: 'Sign in again',
                  href: '/auth/google',
                  onClick: () => {
                    try {
                      // Sign-in returns to the bare address, so the page waits here meanwhile.
                      if (!demo && page !== 'overview')
                        window.sessionStorage.setItem(RETURN_PAGE_KEY, addressOf(page));
                    } catch {
                      // Signing in still works; the member just lands on the Overview.
                    }
                  },
                },
              ]}
            >
              Your session ended. Sign in again to keep the ledger up to date.
            </ConnectionNotice>
          ) : (
            ledger.error && (
              <ConnectionNotice
                actions={[
                  {
                    label: 'Reconnect',
                    onClick: () =>
                      void ledger
                        .refresh()
                        .then(() => focusPageHeading())
                        .catch(() => {}),
                  },
                ]}
              >
                {ledger.error}
              </ConnectionNotice>
            )
          )}
          {page === 'cli' && cliContent}
          {page === 'mcp' && mcpContent}
          {page === 'lobster-prices' && (
            <LobsterPrices onNavigate={navigate} onNotify={(message) => showToast(message)} />
          )}
          {page === 'overview' && (
            <Overview
              state={state}
              memberId={memberId}
              onBet={(bet) => setSelectedId(bet.id)}
              onNavigate={navigate}
              onNewBet={openNewBet}
              now={now}
            />
          )}
          {page === 'ledger' && (
            <LedgerView
              state={state}
              memberId={memberId}
              onBet={(bet) => setSelectedId(bet.id)}
              search={search}
              setSearch={setSearch}
              onNewBet={openNewBet}
            />
          )}
          {page === 'balances' && (
            <BalancesView
              state={state}
              memberId={memberId}
              onOffset={async (preview) => {
                await ledger.offsetDebts(preview);
                showToast(
                  offsetToast(
                    nameOf(preview.counterpartyId),
                    preview.rolls,
                    new Set(preview.allocations.map((item) => item.betId)).size,
                  ),
                );
              }}
              onBet={(bet) => setSelectedId(bet.id)}
              onNewBet={() => {
                setNewBetMode('new');
                setNewBet(true);
              }}
            />
          )}
          {page === 'leaderboard' && (
            <LeaderboardView
              state={state}
              memberId={memberId}
              onBet={(bet) => setSelectedId(bet.id)}
              onViewBets={(person) => {
                setSearch(person.name);
                navigate('ledger');
              }}
            />
          )}
          {page === 'places' && (
            <PlacesView
              state={state}
              memberId={memberId}
              onBet={(bet) => setSelectedId(bet.id)}
              onPriceSaved={savePrice}
              onPriceCorrected={correctPrice}
              onPriceWithdrawn={withdrawPrice}
              onNewBet={(placeId) => {
                setNewBetMode('new');
                setNewBetPlace(placeId);
                setNewBet(true);
              }}
            />
          )}
          {page === 'members' && (
            <MembersView
              state={state}
              memberId={memberId}
              onBet={(bet) => setSelectedId(bet.id)}
              onInvite={openInvite}
              onBetWith={(person) => {
                setNewBetMode('new');
                setNewBetOpponent(person.id);
                setNewBet(true);
              }}
              onViewBets={(person) => {
                setSearch(person.name);
                navigate('ledger');
              }}
              invitations={demo ? undefined : <PendingInvitations refreshKey={inviteLink} />}
            />
          )}
          {page === 'inbox' && (
            <InboxView
              state={state}
              memberId={memberId}
              onBet={(bet) => setSelectedId(bet.id)}
              onNewBet={openNewBet}
              now={now}
            />
          )}
        </main>
      </div>
      {profileOpen && (
        <ProfileDialog
          key={memberId}
          member={member}
          members={state.members}
          onSave={async (name) => {
            await ledger.updateProfile(name);
            showToast('Display name updated.');
          }}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {newBet && (
        <NewBetDialog
          key={`${memberId}-${newBetMode}`}
          open
          mode={newBetMode}
          initialPlaceId={newBetPlace}
          initialOpponentId={newBetOpponent}
          onClose={() => {
            setNewBet(false);
            setNewBetPlace(undefined);
            setNewBetOpponent(undefined);
          }}
          state={state}
          memberId={memberId}
          onCreate={create}
        />
      )}
      {selected && (
        <BetDetail
          key={selected.id}
          bet={selected}
          members={state.members}
          memberId={memberId}
          onClose={() => setSelectedId(undefined)}
          onAction={act}
          openAtNextStep={selected.id === proposedId}
          leaveRef={sheetLeave}
          bets={state.bets}
          places={state.places}
          onOpenBet={(betId) => {
            if (state.bets.some((bet) => bet.id === betId)) setSelectedId(betId);
          }}
        />
      )}
      <Modal
        open={invite}
        onClose={() => setInvite(false)}
        title="Invite a member"
        description={
          demo
            ? 'Add a sample member to try a wager with someone new. Real invitations become available in the private workspace.'
            : inviteLink
              ? 'Your single-use invitation is ready. It expires in 3 days.'
              : 'Create a single-use invitation, then share it by text or link. They’ll join with their own Google account.'
        }
      >
        {!inviteLink ? (
          <form
            className="bet-form"
            onSubmit={createInvite}
            onChange={() => {
              inviteFields.clear('name');
              setInviteError('');
            }}
            noValidate
          >
            <FieldErrorsProvider value={inviteFields}>
              <div className="field">
                <label>
                  Their name
                  <input
                    ref={inviteNameField}
                    name="name"
                    value={inviteName}
                    onChange={(event) => setInviteName(event.target.value)}
                    placeholder="e.g. Jamie Chen"
                    required
                    minLength={LIMITS.memberName.min}
                    maxLength={LIMITS.memberName.max}
                    autoComplete="off"
                    autoFocus
                    data-required-message={MEMBER_NAME_BLANK}
                    {...inviteFields.aria('name')}
                  />
                </label>
                <FieldError name="name" alert />
              </div>
              <p className="form-note">
                <ShieldCheck size={17} />
                {demo
                  ? 'This adds a demo person, without sending a message or creating an account.'
                  : 'They’ll appear in the ledger under this name. The invitation expires in 3 days and can only be used once. Share it directly with the person you’re inviting.'}
              </p>
              <div className="modal-footer">
                {inviteError && (
                  <p className="form-error" role="alert">
                    {inviteError}
                  </p>
                )}
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setInvite(false)}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  aria-disabled={inviteBusy || undefined}
                  aria-busy={inviteBusy || undefined}
                >
                  {inviteBusy ? 'Creating…' : demo ? 'Add demo member' : 'Create invitation'}
                  <ArrowRight size={15} />
                </button>
              </div>
            </FieldErrorsProvider>
          </form>
        ) : (
          <div className="invite-result">
            <span className="invite-success">
              <Check size={25} />
            </span>
            <h3 ref={inviteReady} tabIndex={-1}>
              {inviteName}’s invitation is ready.
            </h3>
            <p>Share this link directly. They can sign in with Google and join the ledger.</p>
            <label>
              Invitation link
              <input readOnly value={inviteLink} onFocus={(event) => event.target.select()} />
            </label>
            <div className="share-actions">
              <button className="button button-primary" onClick={() => void copyInvite()}>
                <Copy size={16} />
                Copy link
              </button>
              <a
                className="button button-secondary"
                href={`sms:?body=${encodeURIComponent(shareText)}`}
              >
                <MessageSquare size={16} />
                Send by text
              </a>
              {!!navigator.share && (
                <button
                  className="button button-secondary"
                  onClick={() =>
                    void navigator
                      .share({ title: 'Join The Lobster Ledger', text: shareText, url: inviteLink })
                      .catch(() => {})
                  }
                  aria-label="Share invitation"
                >
                  <Share2 size={17} />
                </button>
              )}
            </div>
            {inviteError && (
              <p className="form-error" role="alert">
                {inviteError}
              </p>
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset the demo?"
        description="This clears every bet, price report and member you added in this browser and brings back the sample ledger. Close any other tab showing this demo first, or those tabs can bring their bets back. Nothing outside the demo is touched."
      >
        <div className="modal-footer">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => setResetOpen(false)}
          >
            Keep my changes
          </button>
          <button className="button button-primary" type="button" onClick={resetDemo}>
            <RotateCcw size={16} />
            Reset demo
          </button>
        </div>
      </Modal>
      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Your ledger, to keep."
        description="Take the bets or the price reports as a spreadsheet, or keep one archive of everything."
      >
        <div className="export-options">
          <button
            onClick={() => {
              const filename = exportFilename('csv');
              downloadFile(
                exportCsv(state.bets, state.members),
                filename,
                'text/csv;charset=utf-8',
              );
              showToast(exportToast(filename, state.bets.length));
              setExportOpen(false);
            }}
          >
            <Download size={24} />
            <span>
              <strong>Bets (.csv)</strong>
              <small>Every bet, participant, stake, result, and timestamp. No price reports.</small>
            </span>
            <ArrowRight size={18} />
          </button>
          <button
            onClick={() => {
              const filename = exportFilename('prices');
              downloadFile(exportPricesCsv(state), filename, 'text/csv;charset=utf-8');
              showToast(pricesExportToast(filename, state.priceObservations?.length ?? 0));
              setExportOpen(false);
            }}
          >
            <Download size={24} />
            <span>
              <strong>Price reports (.csv)</strong>
              <small>
                Every price report, corrected and withdrawn ones included: restaurant, item, price,
                visit date, and reporter.
              </small>
            </span>
            <ArrowRight size={18} />
          </button>
          <button
            onClick={() => {
              const filename = exportFilename('json');
              downloadFile(
                exportJson(state, { mode: demo ? 'demo' : 'shared' }),
                filename,
                'application/json',
              );
              showToast(
                archiveExportToast(
                  filename,
                  state.bets.length,
                  state.priceObservations?.length ?? 0,
                ),
              );
              setExportOpen(false);
            }}
          >
            <ShieldCheck size={24} />
            <span>
              <strong>Complete audit archive (.json)</strong>
              <small>
                Every bet and price report, with identities, approvals, and event history.
              </small>
            </span>
            <ArrowRight size={18} />
          </button>
        </div>
      </Modal>
      <Modal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="A proper record of a friendly bet."
        description="Everyone approves their own side. Nothing is settled by assumption."
      >
        <div className="house-rules-list">
          {/* list-style: none makes Safari drop the list role, so it is stated. */}
          <ol role="list">
            {RULES.steps.map(({ title, body }, index) => (
              <li key={title}>
                <span aria-hidden="true">{index + 1}</span>
                <section>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </section>
              </li>
            ))}
          </ol>
          <p className="form-note">
            <ShieldCheck size={18} />
            {RULES.note}
          </p>
          <button
            className="button button-secondary"
            onClick={() => {
              setHelpOpen(false);
              navigate('cli');
            }}
          >
            <Terminal size={17} />
            Get the command-line app
          </button>
        </div>
      </Modal>
      <ToastRegion toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
