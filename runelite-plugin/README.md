# OSRS Flip Advisor Tracker

This is the source for a read-only RuneLite companion plugin. It observes
`GrandExchangeOfferChanged` and sends two kinds of update to the local advisor:
the newly filled quantity and coins since the previous event (a fill delta), and
a snapshot of each open or completed offer (state, price, and progress) so the
advisor can track unfilled orders and their age.

It does not add menu actions, generate input, place offers, cancel offers, or
modify the game client. The open-offer snapshots are read-only observations; all
re-pricing and cancelling remains a manual decision you make in the game.

---

# Super-detailed setup guide (Windows)

This guide walks you through everything, one tiny step at a time. You do **not**
need to know how to code. If you can install a program and copy-and-paste, you
can do this. Read every step in order and do exactly what it says.

> These instructions are for a **Windows** "gaming PC" where you both play Old
> School RuneScape and run the advisor. That is the simplest setup because
> everything talks to itself on one computer.

## 1. What are we even doing? (the simple version)

Think of it like this:

- **The advisor** is a little helper program that runs quietly in the
  background. It watches Grand Exchange prices and keeps a list of your orders.
- **The plugin** is a small add-on for RuneLite (the game client). Its only job
  is to whisper to the advisor: "Hey, this order just filled," or "this order is
  still sitting here." It never plays the game for you.
- **You** still place every buy and sell yourself, by hand, in the game.

So we need to (a) turn on the helper, and (b) start a special version of the
game that has the whisper-add-on built in. That's it.

## 2. Words you will see (a tiny dictionary)

- **PowerShell**: a black text window where you type commands. Like a notepad
  that does things when you press Enter.
- **JDK / Java**: the engine that runs RuneLite. We install version **11**.
- **Node**: the engine that runs the advisor helper.
- **Git**: a tool that downloads the project's files from the internet.
- **Token**: a secret password the plugin uses so only *your* plugin can talk to
  *your* advisor. We copy and paste it once.
- **GE**: the Grand Exchange (the in-game marketplace).

## 3. Install the three tools you need (do this once)

Install these three programs. For each one, just click the big download button,
then run the installer and click **Next / Next / Install** unless a step below
says otherwise.

1. **Java (JDK 11)** — Download the **Windows .msi** from:
   <https://adoptium.net/temurin/releases/?version=11>
   - When the installer shows a list of options with little hard-drive icons,
     turn **ON** the ones named **"Set JAVA_HOME variable"** and
     **"Add to PATH"**. (Click the icon and choose "Will be installed".)
2. **Node.js** — Download the **LTS** version (the big green button) from:
   <https://nodejs.org>
   - Just click Next through everything. (We need version 20 or newer; the LTS
     button gives you that.)
3. **Git** — Download from: <https://git-scm.com/download/win>
   - Just click Next through everything.

### Check that they installed correctly

1. Press the **Windows key**, type `powershell`, and press **Enter**. A black
   window opens.
2. Type each line below and press **Enter** after each one:

```powershell
java -version
node -v
git --version
```

You should see a version number after each (the Java one should start with
`11`). If any says *"is not recognized"*, that program did not install right —
re-run its installer, then **close and reopen PowerShell** and try again.

## 4. Download the project (do this once)

In the same PowerShell window, type these two lines (press Enter after each):

```powershell
git clone https://github.com/twozach2/osrs-flip-advisor.git
cd osrs-flip-advisor
```

- If Git asks you to sign in to GitHub, do so.
- The first line copies all the project files onto your PC. The second line
  steps *into* the project folder. From now on, keep using this same window so
  you stay inside that folder.

> No GitHub access? You can instead click the green **Code** button on the
> project's GitHub page, choose **Download ZIP**, unzip it, and then in
> PowerShell `cd` into the unzipped folder.

## 5. Start the advisor helper (do this every time you play)

Still in PowerShell, type:

```powershell
node server.mjs
```

- Leave this window **open** the whole time you play. Closing it turns the
  helper off.
- Open your web browser and go to: <http://localhost:4173>
  You should see the OSRS Flip Advisor dashboard. That means the helper is
  running. 🎉
- On a brand-new install, the dashboard may open before it has enough market
  history to fill the eight GE slots. Wait until the top-right status says
  **Updated** and the **History samples** card starts increasing. If **Fill empty
  slots** says it cannot find enough historical markets, leave the server running
  for a while and refresh. You can also temporarily uncheck **Historical targets
  only** if you want live-spread fallback ideas while the local history builds.

## 6. Get your secret token (do this once)

Open a **second** PowerShell window (Windows key → `powershell` → Enter), then:

```powershell
cd osrs-flip-advisor
type data\ingest-token.txt
```

A long jumble of letters and numbers appears. **Select it with your mouse and
copy it** (Ctrl+C). That's your token. Keep this window; we'll use it next.

> If the file isn't there yet, it means the advisor (step 5) hasn't been started
> at least once. Start it, then try again.

## 7. Start the game-with-plugin (do this every time you play)

In that **second** PowerShell window, type these two lines:

```powershell
cd runelite-plugin
.\gradlew.bat run
```

- **The very first time**, this downloads a lot of files and can take several
  minutes. Be patient — let it finish. (Later times are fast.)
- When it's done, a normal **RuneLite game window opens by itself.**

## 8. Log in to the game

Log in like you normally would.

- If you use a **Jagex account**, the special dev client needs one extra setup
  step the first time. Follow this official guide exactly:
  <https://github.com/runelite/runelite/wiki/Using-Jagex-Accounts>
- This part is the most fiddly. If you get stuck, it's okay to ask a grown-up or
  a techy friend for a hand here.

## 9. Paste your token and turn the plugin on (do this once)

**Important:** the plugin's on/off switch won't turn on until you're logged into
the game, so make sure you finished step 8 first.

In the RuneLite window:

1. Click the **wrench icon** 🔧 on the right-side toolbar (that's "Configuration").
2. In the search box, type **Flip**. You'll see **"OSRS Flip Advisor Tracker"**.
3. Click its **name** (or the gear next to it) to open its settings.
4. You'll see two boxes:
   - **Local endpoint** — leave it exactly as it is
     (`http://127.0.0.1:4173/api/ge-events`). Don't change it.
   - **Ingest token** — click in this box and **paste** (Ctrl+V) the token you
     copied in step 6.
5. Now click the little **on/off switch** next to **"OSRS Flip Advisor Tracker"**
   so it turns on. (This only works once you're logged in.)
6. That's it. RuneLite saves it automatically.

## 10. Test that it's working

1. In the game, place any small Grand Exchange **buy** offer (for example, bid a
   little low on a common item).
2. Go back to your browser at <http://localhost:4173> and refresh the page.
3. Look for the **"Open orders"** section. Your new order should show up there
   within a few seconds. ✅

If you see it, congratulations — the plugin is talking to the advisor!

## Doing it again next time (the short version)

Once everything is installed and the token is pasted, your routine is just:

1. PowerShell window 1: `cd osrs-flip-advisor` then `node server.mjs`.
2. PowerShell window 2: `cd osrs-flip-advisor\runelite-plugin` then
   `.\gradlew.bat run`.
3. Play. Watch your orders on <http://localhost:4173>.

## If something goes wrong

| What you see | What it usually means | What to do |
| --- | --- | --- |
| `java`/`node`/`git` "is not recognized" | The tool isn't installed or isn't on PATH | Re-run that installer (tick "Add to PATH" for Java), then close and reopen PowerShell |
| `.\gradlew.bat run` fails the first time | A download got interrupted | Just run the same command again |
| Dashboard won't load at localhost:4173 | The advisor (step 5) isn't running | Start `node server.mjs` and leave that window open |
| Nothing shows in "Open orders" | Token typo, or wrong window | Re-copy the token (step 6) and re-paste it (step 9); make sure the advisor is running |
| "address already in use" / port 4173 busy | The advisor is already running somewhere | Close the old PowerShell window running it, then start again |

## Optional: make a single double-clickable launcher

If you'd rather not type the Gradle command each time, you can build one big
self-contained file:

```powershell
cd osrs-flip-advisor\runelite-plugin
.\gradlew.bat shadowJar
```

This creates `build\libs\osrs-flip-advisor-tracker-0.1.0-all.jar`. From then on
you can start the game-with-plugin by running:

```powershell
java -jar build\libs\osrs-flip-advisor-tracker-0.1.0-all.jar
```

(You still need the advisor from step 5 running for tracking to work.)

---

## A note for advanced users / Plugin Hub

The steps above run the plugin in RuneLite's local **developer mode**, which is
the supported way to use a personal plugin without publishing it. If you ever
want this available in a normal RuneLite install for other people, the source
should be reviewed and accepted through the RuneLite **Plugin Hub** process.
This repository does not include a RuneLite distribution or bypass that review.
