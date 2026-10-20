import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert, FolderOpen, MessageCircle, Mic, Power, MonitorSmartphone, RefreshCw, RotateCcw, ShieldCheck,
  TerminalSquare, Volume2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Bridge, onEvent, type ClaudeStatus, type HookStatus,
} from "@/island/core/bridge";
import { DEFAULT_SETTINGS, type ChatAccess, type Settings } from "@/island/core/state";
import { ApiKeyPanel } from "./ApiKeyPanel";
import { HooksDialog } from "./HooksDialog";

/** Whisper sizes, with what each costs on first use. */
const VOICE_MODELS = [
  { value: "tiny", label: "Fast", hint: "about 60 MB" },
  { value: "base", label: "Balanced", hint: "about 130 MB" },
  { value: "small", label: "Most accurate", hint: "about 500 MB, slower" },
];

/** Radix Select has no empty value either. */
const AUTO_LANGUAGE = "auto";
const VOICE_LANGUAGES = [
  { value: AUTO_LANGUAGE, label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "ur", label: "Urdu" },
  { value: "hi", label: "Hindi" },
  { value: "ar", label: "Arabic" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "tr", label: "Turkish" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
];

/** Radix Select has no empty value, so "the CLI's own default" gets a name. */
const DEFAULT_MODEL = "default";
const MODELS = [
  { value: DEFAULT_MODEL, label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`size-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />;
}

function Row({
  label, hint, htmlFor, children,
}: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [version, setVersion] = useState("");
  const [packaged, setPackaged] = useState(true);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [hooks, setHooks] = useState<HookStatus | null>(null);
  const [hooksDialog, setHooksDialog] = useState<"install" | "remove" | null>(null);

  const refreshClaude = useCallback(async () => {
    setChecking(true);
    setClaude(await Bridge.claudeStatus());
    setChecking(false);
  }, []);
  const refreshHooks = useCallback(async () => setHooks(await Bridge.hooksStatus()), []);

  useEffect(() => {
    void Bridge.boot().then((boot) => {
      if (!boot) return;
      setSettings({ ...DEFAULT_SETTINGS, ...boot.settings });
      setVersion(boot.version);
      setPackaged(boot.packaged);
    });
    void refreshClaude();
    void refreshHooks();
    // The island has its own sound and auto-close controls; stay in step with it.
    return onEvent<Settings>("settings-changed", (s) => setSettings((prev) => ({ ...prev, ...s })));
  }, [refreshClaude, refreshHooks]);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void Bridge.saveSettings(next);
  };

  const pickFolder = async () => {
    const folder = await Bridge.pickFolder();
    if (folder) update({ chatCwd: folder });
  };

  const ready = claude?.found === true && claude.loggedIn;
  const usingKey = settings.authMode === "apikey";

  return (
    <ScrollArea className="h-screen">
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
        <header className="flex items-end justify-between pb-1">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Poupou</h1>
            <p className="text-sm text-muted-foreground">
              Lives at the top of your screen and keeps an eye on Claude Code.
            </p>
          </div>
          {version && <Badge variant="secondary">v{version}</Badge>}
        </header>

        {/* ── Subscription + chat ─────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="size-4" /> Chat
            </CardTitle>
            <CardDescription>
              {usingKey
                ? "Answers are billed to your Anthropic API key."
                : "Answers come from Claude Code on this computer, using the Claude subscription it is signed in with."}
            </CardDescription>
            {!usingKey && (
              <CardAction>
                <Button variant="ghost" size="icon-sm" onClick={refreshClaude} disabled={checking} title="Check again">
                  <RefreshCw className={checking ? "animate-spin" : ""} />
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Row label="Connect with" htmlFor="auth-mode">
              <Select
                value={settings.authMode}
                onValueChange={(v) => update({ authMode: v as Settings["authMode"] })}
              >
                <SelectTrigger id="auth-mode" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">Claude subscription (Claude Code)</SelectItem>
                  <SelectItem value="apikey">Anthropic API key</SelectItem>
                </SelectContent>
              </Select>
            </Row>

            {usingKey ? (
              <ApiKeyPanel />
            ) : (
            <>
            <div className="flex flex-wrap items-center gap-2">
              {claude == null ? (
                <Badge variant="secondary">Checking…</Badge>
              ) : (
                <Badge variant="outline" className="gap-1.5">
                  <StatusDot ok={ready} />
                  {!claude.found ? "CLI not found" : claude.loggedIn ? "Signed in" : "Not signed in"}
                </Badge>
              )}
              {claude?.plan && <Badge variant="secondary">{claude.plan}</Badge>}
              {claude?.email && <span className="text-xs text-muted-foreground">{claude.email}</span>}
              {claude?.version && (
                <span className="ml-auto text-xs text-muted-foreground">CLI {claude.version}</span>
              )}
            </div>

            {claude && !ready && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>{claude.found ? "Sign in to Claude Code" : "Claude Code isn't installed"}</AlertTitle>
                <AlertDescription>
                  {claude.found
                    ? "Open a terminal, run `claude`, and use /login. Then press the refresh button above."
                    : "Install Claude Code, run `claude` once to sign in, then press the refresh button above — or switch to an Anthropic API key."}
                </AlertDescription>
              </Alert>
            )}
            </>
            )}

            <Separator />

            <Row label="Model" hint="Which model answers in the island." htmlFor="model">
              <Select
                value={settings.model || DEFAULT_MODEL}
                onValueChange={(v) => update({ model: v === DEFAULT_MODEL ? "" : v })}
              >
                <SelectTrigger id="model" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>

            <Row
              label="When Claude wants to change something"
              hint={
                settings.chatAccess === "ask"
                  ? "Commands and file edits show an Allow / Deny card on the island."
                  : "Claude can read and search, but never run commands or edit files."
              }
              htmlFor="access"
            >
              <Select value={settings.chatAccess} onValueChange={(v) => update({ chatAccess: v as ChatAccess })}>
                <SelectTrigger id="access" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">Ask me first</SelectItem>
                  <SelectItem value="readonly">Read-only</SelectItem>
                </SelectContent>
              </Select>
            </Row>

            <div className="space-y-2">
              <Label htmlFor="cwd">Working folder</Label>
              <div className="flex gap-2">
                <Input id="cwd" readOnly value={settings.chatCwd || "Home folder"} className="font-mono text-xs" />
                <Button variant="secondary" onClick={pickFolder}>
                  <FolderOpen /> Browse
                </Button>
                {settings.chatCwd && (
                  <Button variant="ghost" size="icon" title="Back to the home folder" onClick={() => update({ chatCwd: "" })}>
                    <RotateCcw />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Where the chat reads files and runs commands. Changing it starts a new conversation.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Claude Code hooks ───────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TerminalSquare className="size-4" /> Claude Code sessions
            </CardTitle>
            <CardDescription>
              Hooks let the island follow your sessions in VS Code or any terminal, and approve
              permission requests from the top of the screen.
            </CardDescription>
            <CardAction>
              <Badge variant="outline" className="gap-1.5">
                <StatusDot ok={hooks?.installed === true} />
                {hooks?.installed ? "Installed" : "Not installed"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              <p>
                You see the exact change to <span className="font-mono">settings.json</span> before
                anything is written, a dated backup is taken, and your own hooks are never touched.
                If Poupou is closed, the hook exits at once — Claude Code is never blocked.
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setHooksDialog("install")}>
                {hooks?.installed ? "Reinstall hooks…" : "Install hooks…"}
              </Button>
              {hooks?.installed && (
                <Button variant="outline" onClick={() => setHooksDialog("remove")}>
                  Remove hooks…
                </Button>
              )}
            </div>
            {hooks && (
              <p className="truncate font-mono text-[11px] text-muted-foreground" title={hooks.settingsPath}>
                {hooks.settingsPath}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Voice ───────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="size-4" /> Voice
            </CardTitle>
            <CardDescription>
              Click the microphone in the chat, or press{" "}
              <kbd className="rounded border px-1 font-mono text-[11px]">Ctrl+Shift+Space</kbd>{" "}
              anywhere, talk, then click again. Speech is turned into text on this computer — the
              audio never leaves it. The speech model downloads once, the first time.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Row
              label="Speech model"
              hint={VOICE_MODELS.find((m) => m.value === settings.voiceModel)?.hint}
              htmlFor="voice-model"
            >
              <Select
                value={settings.voiceModel}
                onValueChange={(v) => update({ voiceModel: v as Settings["voiceModel"] })}
              >
                <SelectTrigger id="voice-model" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICE_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Language you speak" hint="Picking one is more reliable for short phrases." htmlFor="voice-lang">
              <Select
                value={settings.voiceLanguage || AUTO_LANGUAGE}
                onValueChange={(v) => update({ voiceLanguage: v === AUTO_LANGUAGE ? "" : v })}
              >
                <SelectTrigger id="voice-lang" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICE_LANGUAGES.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row
              label="Send as soon as it's written"
              hint="Off: the text lands in the box so you can check it first."
              htmlFor="voice-send"
            >
              <Switch
                id="voice-send"
                checked={settings.voiceAutoSend}
                onCheckedChange={(v) => update({ voiceAutoSend: v })}
              />
            </Row>
          </CardContent>
        </Card>

        {/* ── Island ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MonitorSmartphone className="size-4" /> Island
            </CardTitle>
            <CardDescription>
              Move the pointer to the top-centre of the screen to make it peek out.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Row label="Sounds" htmlFor="sound">
              <Switch id="sound" checked={settings.soundEnabled} onCheckedChange={(v) => update({ soundEnabled: v })} />
            </Row>
            <Row label="Volume">
              <div className="flex w-48 items-center gap-2">
                <Volume2 className="size-4 text-muted-foreground" />
                <Slider
                  min={0}
                  max={0.2}
                  step={0.005}
                  disabled={!settings.soundEnabled}
                  value={[settings.soundVolume]}
                  onValueChange={([v]) => update({ soundVolume: v })}
                />
              </div>
            </Row>
            <Separator />
            <Row label="Close on its own after" hint="Once the pointer has left the island." htmlFor="autoclose">
              <Select
                value={String(settings.autoCloseInterval)}
                onValueChange={(v) => update({ autoCloseInterval: Number(v) })}
              >
                <SelectTrigger id="autoclose" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 15, 30, 60].map((s) => (
                    <SelectItem key={s} value={String(s)}>{s} seconds</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row
              label={navigator.platform.startsWith("Mac") ? "Open at login" : "Start with Windows"}
              hint={packaged ? undefined : "Available in the installed app, not under npm run dev."}
              htmlFor="autostart"
            >
              <Switch
                id="autostart"
                disabled={!packaged}
                checked={settings.autostart}
                onCheckedChange={(v) => update({ autostart: v })}
              />
            </Row>
            <Row label="Display" htmlFor="screen">
              <Select value={settings.screen} onValueChange={(v) => update({ screen: v as Settings["screen"] })}>
                <SelectTrigger id="screen" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cursor">Any display — follows the pointer</SelectItem>
                  <SelectItem value="primary">Main display only</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between px-1 pb-2">
          <p className="text-xs text-muted-foreground">
            Closing this window keeps Poupou running at the top of the screen.
          </p>
          <Button variant="outline" size="sm" onClick={() => void Bridge.quit()}>
            <Power /> Quit Poupou
          </Button>
        </div>
      </main>

      <HooksDialog
        mode={hooksDialog}
        onClose={() => setHooksDialog(null)}
        onApplied={refreshHooks}
      />
    </ScrollArea>
  );
}
