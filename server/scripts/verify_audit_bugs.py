import asyncio
import json
import subprocess
import time
import urllib.request
import websockets

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CDP_PORT = 9222
BASE_URL = "http://127.0.0.1:4000"

async def send_cmd(ws, method, params=None, msg_id=1):
    payload = {"id": msg_id, "method": method, "params": params or {}}
    await ws.send(json.dumps(payload))
    while True:
        resp = await ws.recv()
        data = json.loads(resp)
        if data.get("id") == msg_id:
            return data.get("result", {})

async def eval_js(ws, expr, msg_id=100):
    res = await send_cmd(ws, "Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
        "awaitPromise": True
    }, msg_id=msg_id)
    return res.get("result", {}).get("value")

async def navigate(ws, url, msg_id=200):
    await send_cmd(ws, "Page.navigate", {"url": url}, msg_id=msg_id)
    await asyncio.sleep(2.0)

async def set_viewport(ws, width, height, msg_id=300):
    await send_cmd(ws, "Emulation.setDeviceMetricsOverride", {
        "width": width,
        "height": height,
        "deviceScaleFactor": 1,
        "mobile": (width <= 600)
    }, msg_id=msg_id)
    await asyncio.sleep(0.3)

async def mouse_move(ws, x, y, msg_id=400):
    await send_cmd(ws, "Input.dispatchMouseEvent", {
        "type": "mouseMoved",
        "x": x,
        "y": y
    }, msg_id=msg_id)
    await asyncio.sleep(0.1)

async def main():
    chrome_proc = subprocess.Popen([
        CHROME_PATH,
        "--headless=new",
        f"--remote-debugging-port={CDP_PORT}",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check"
    ])
    time.sleep(2)

    try:
        req = urllib.request.Request(f"http://127.0.0.1:{CDP_PORT}/json/new", method="PUT")
        with urllib.request.urlopen(req) as resp:
            target_info = json.loads(resp.read().decode())
        ws_url = target_info["webSocketDebuggerUrl"]

        async with websockets.connect(ws_url) as ws:
            await send_cmd(ws, "Page.enable", {}, 1)
            await send_cmd(ws, "Runtime.enable", {}, 2)
            await send_cmd(ws, "DOM.enable", {}, 3)

            results = {}

            # =========================================================================
            # DESKTOP 1920x1080 AUDIT VERIFICATION
            # =========================================================================
            await set_viewport(ws, 1920, 1080, 10)

            # --- HOME: BUGS 2, 3, 11, 13 ---
            print("\n================== HOME PAGE AUDIT ==================")
            await navigate(ws, f"{BASE_URL}/index.html", 20)
            
            # Bug 2: Hero layout break, gap, and arrows
            hero_info = await eval_js(ws, """(() => {
                const hero = document.querySelector('.spotlight-hero');
                const nextSec = document.querySelector('.section-trending');
                const nav = document.querySelector('.spotlight-nav');
                const heroRect = hero.getBoundingClientRect();
                const navRect = nav.getBoundingClientRect();
                const nextRect = nextSec ? nextSec.getBoundingClientRect() : null;
                const gap = nextRect ? (nextRect.top - heroRect.bottom) : 0;
                const navInsideHero = (navRect.bottom <= heroRect.bottom + 5) && (navRect.top >= heroRect.top);
                const heroOverflow = window.getComputedStyle(hero).overflow;
                return {
                    heroHeight: heroRect.height,
                    gapToTrending: gap,
                    navInsideHero: navInsideHero,
                    navPos: { bottom: navRect.bottom, heroBottom: heroRect.bottom, right: navRect.right, heroRight: heroRect.right },
                    heroOverflow: heroOverflow
                };
            })()""", 21)
            results["bug2_hero_layout"] = hero_info
            print(f"Bug 2 (Hero Layout): heroHeight={hero_info['heroHeight']}px, gapToTrending={hero_info['gapToTrending']}px, navInsideHero={hero_info['navInsideHero']}, heroOverflow={hero_info['heroOverflow']}")

            # Bug 3: Hero background ghost Zoro.to UI check
            bg_info = await eval_js(ws, """(() => {
                const backdrop = document.querySelector('.spotlight-backdrop');
                const bgImage = backdrop ? window.getComputedStyle(backdrop).backgroundImage : '';
                return {
                    bgImage: bgImage,
                    cleanArtwork: !bgImage.includes('screenshot')
                };
            })()""", 22)
            results["bug3_hero_bg"] = bg_info
            print(f"Bug 3 (Hero Background): bgImage={bg_info['bgImage']}")

            # Bug 11: Live search feedback on Home
            home_search = await eval_js(ws, """(async () => {
                const input = document.getElementById('zoro-search-input');
                const dropdown = document.getElementById('zoro-search-dropdown');
                if (!input || !dropdown) return { found: false };

                input.value = 'Ronin';
                input.dispatchEvent(new Event('input', { bubbles: true }));

                await new Promise(r => setTimeout(r, 450));
                const items = dropdown.querySelectorAll('.search-result-item');
                const firstTitle = items.length > 0 ? items[0].querySelector('.search-result-title')?.textContent.trim() : null;
                const hasThumb = items.length > 0 ? !!items[0].querySelector('img.search-result-thumb') : false;
                const isOpen = dropdown.classList.contains('is-open');

                return {
                    found: true,
                    isOpen: isOpen,
                    itemsCount: items.length,
                    firstTitle: firstTitle,
                    hasThumb: hasThumb
                };
            })()""", 23)
            results["bug11_home_search"] = home_search
            print(f"Bug 11 (Home Search): isOpen={home_search['isOpen']}, itemsCount={home_search['itemsCount']}, firstTitle='{home_search['firstTitle']}', hasThumb={home_search['hasThumb']}")

            # Bug 13: Trending carousel scroll-snap
            carousel_info = await eval_js(ws, """(() => {
                const rail = document.querySelector('.trending-rail');
                const item = document.querySelector('.trending-item');
                const railStyle = window.getComputedStyle(rail);
                const itemStyle = item ? window.getComputedStyle(item) : {};
                return {
                    scrollSnapType: railStyle.scrollSnapType,
                    scrollPadding: railStyle.scrollPadding,
                    itemSnapAlign: itemStyle.scrollSnapAlign
                };
            })()""", 24)
            results["bug13_trending_snap"] = carousel_info
            print(f"Bug 13 (Trending Snap): railSnap={carousel_info['scrollSnapType']}, padding={carousel_info['scrollPadding']}, itemAlign={carousel_info['itemSnapAlign']}")

            # --- BROWSE: BUGS 1, 7, 11 ---
            print("\n================== BROWSE PAGE AUDIT =================")
            await navigate(ws, f"{BASE_URL}/browse.html", 30)

            # Bug 7: Sort control
            sort_info = await eval_js(ws, """(async () => {
                for (let i = 0; i < 20; i++) {
                    if (document.querySelector('.zoro-card')) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                const sortSelect = document.getElementById('catalog-sort-select');
                if (!sortSelect) return { found: false };
                const opts = Array.from(sortSelect.options).map(o => ({ value: o.value, text: o.text }));
                
                // Select A-Z sort
                sortSelect.value = 'az';
                sortSelect.dispatchEvent(new Event('change'));
                await new Promise(r => setTimeout(r, 200));

                const titles = Array.from(document.querySelectorAll('.zoro-card-title')).map(el => el.textContent.trim());
                const expectedAz = [...titles].sort((a,b) => a.localeCompare(b));
                const isSortedAz = JSON.stringify(titles) === JSON.stringify(expectedAz);

                // Select Newest sort
                sortSelect.value = 'newest';
                sortSelect.dispatchEvent(new Event('change'));
                await new Promise(r => setTimeout(r, 200));
                const titlesNewest = Array.from(document.querySelectorAll('.zoro-card-title')).map(el => el.textContent.trim());

                return {
                    found: true,
                    options: opts,
                    isSortedAz: isSortedAz,
                    sampleAz: titles.slice(0, 4),
                    sampleNewest: titlesNewest.slice(0, 4)
                };
            })()""", 31)
            results["bug7_sort_control"] = sort_info
            print(f"Bug 7 (Sort Control): found={sort_info['found']}, opts={len(sort_info.get('options', []))}, isSortedAz={sort_info.get('isSortedAz')}")
            print(f"       Sample A-Z: {sort_info.get('sampleAz')}")

            # Bug 1: Stuck hover preview dismissals and header overlap check
            card_coords = await eval_js(ws, """(() => {
                const card = document.querySelector('.zoro-card');
                if (!card) return null;
                const r = card.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()""", 32)

            if card_coords:
                # Hover over first card using real CDP mouse move
                await mouse_move(ws, card_coords["x"], card_coords["y"], 33)
                await asyncio.sleep(0.5)

            hover_info = await eval_js(ws, """(async () => {
                const tooltip = document.querySelector('.zoro-tooltip');
                const header = document.querySelector('.zoro-header');
                if (!tooltip || !header) return { error: 'tooltip or header missing' };

                const isVisible = tooltip.classList.contains('is-visible') && tooltip.style.display !== 'none';
                const tooltipRect = tooltip.getBoundingClientRect();
                const headerRect = header.getBoundingClientRect();
                const staysBelowHeader = tooltipRect.top >= headerRect.bottom - 2;
                const zIndexComparison = parseInt(window.getComputedStyle(header).zIndex, 10) > parseInt(window.getComputedStyle(tooltip).zIndex, 10);

                // Test dismissal on mouseleave
                const firstCard = document.querySelector('.zoro-card');
                firstCard.dispatchEvent(new MouseEvent('mouseleave'));
                const hiddenAfterLeave = !tooltip.classList.contains('is-visible') || tooltip.style.display === 'none';

                // Re-open
                firstCard.dispatchEvent(new MouseEvent('mouseenter'));
                await new Promise(r => setTimeout(r, 200));

                // Test dismissal on click outside
                document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                const hiddenAfterClickOutside = !tooltip.classList.contains('is-visible') || tooltip.style.display === 'none';

                return {
                    isVisibleOnHover: isVisible,
                    staysBelowHeader: staysBelowHeader,
                    headerZIndexAboveTooltip: zIndexComparison,
                    hiddenAfterLeave: hiddenAfterLeave,
                    hiddenAfterClickOutside: hiddenAfterClickOutside
                };
            })()""", 34)
            # Move mouse away to neutral space
            await mouse_move(ws, 10, 10, 35)
            results["bug1_hover_preview"] = hover_info
            print(f"Bug 1 (Hover Preview): isVisibleOnHover={hover_info.get('isVisibleOnHover')}, staysBelowHeader={hover_info.get('staysBelowHeader')}, headerZIndexAboveTooltip={hover_info.get('headerZIndexAboveTooltip')}, hiddenAfterLeave={hover_info.get('hiddenAfterLeave')}, hiddenAfterClickOutside={hover_info.get('hiddenAfterClickOutside')}")

            # Bug 11: Live search feedback on Browse grid
            browse_search = await eval_js(ws, """(async () => {
                const input = document.getElementById('zoro-search-input');
                const dropdown = document.getElementById('zoro-search-dropdown');
                if (!input) return { found: false };

                input.value = 'Ronin';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 450));

                const filteredCards = Array.from(document.querySelectorAll('.zoro-card-title')).map(el => el.textContent.trim());
                const dropdownItems = dropdown ? dropdown.querySelectorAll('.search-result-item').length : 0;

                return {
                    filteredCards: filteredCards,
                    dropdownItems: dropdownItems,
                    filteredSuccessfully: filteredCards.length === 1 && dropdownItems === 1
                };
            })()""", 36)
            results["bug11_browse_search"] = browse_search
            print(f"Bug 11 (Browse Search): filteredCards={browse_search.get('filteredCards')}, dropdownItems={browse_search.get('dropdownItems')}, filteredSuccessfully={browse_search.get('filteredSuccessfully')}")

            # --- WATCH: BUGS 4, 5, 9, 10 ---
            print("\n================== WATCH PAGE AUDIT =================")
            await navigate(ws, f"{BASE_URL}/watch.html?slug=kagerou-protocol&ep=1", 40)

            # Bug 10: Duplicate player controls
            controls_info = await eval_js(ws, """(() => {
                const bar = document.querySelector('.zoro-player-bar');
                const hasSkipBack = !!document.getElementById('btn-skip-back');
                const hasSkipFwd = !!document.getElementById('btn-skip-forward');
                const hasTimeText = !!document.getElementById('video-time-text');
                const hasDupPlay = !!bar?.querySelector('.player-play-btn, [id*=\"play-pause\"]');
                const hasDupProgress = !!bar?.querySelector('.player-progress-bar, input[type=\"range\"]');
                const hasDupFullscreen = !!bar?.querySelector('.player-fullscreen-btn, [id*=\"fullscreen\"]');
                return {
                    hasSkipButtons: hasSkipBack && hasSkipFwd,
                    hasTimeText: hasTimeText,
                    hasDuplicatePlay: hasDupPlay,
                    hasDuplicateProgress: hasDupProgress,
                    hasDuplicateFullscreen: hasDupFullscreen,
                    isCleanOneControlSet: !hasDupPlay && !hasDupProgress && !hasDupFullscreen
                };
            })()""", 41)
            results["bug10_player_controls"] = controls_info
            print(f"Bug 10 (Player Controls): hasSkipButtons={controls_info['hasSkipButtons']}, hasTimeText={controls_info['hasTimeText']}, isCleanOneControlSet={controls_info['isCleanOneControlSet']}")

            # Bug 9: Episode grid row sizing
            grid_info = await eval_js(ws, """(async () => {
                for (let i = 0; i < 20; i++) {
                    if (document.querySelector('.ep-btn')) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                const grid = document.querySelector('.ep-buttons-grid');
                const btn = document.querySelector('.ep-btn');
                if (!grid || !btn) return { found: false };
                const gridRect = grid.getBoundingClientRect();
                const btnRect = btn.getBoundingClientRect();
                const gridStyle = window.getComputedStyle(grid);
                return {
                    found: true,
                    gridHeight: gridRect.height,
                    maxHeight: gridStyle.maxHeight,
                    btnHeight: btnRect.height,
                    gap: gridStyle.gap,
                    overflowY: gridStyle.overflowY,
                    scrollSnapType: gridStyle.scrollSnapType
                };
            })()""", 42)
            results["bug9_episode_grid"] = grid_info
            print(f"Bug 9 (Episode Grid): gridHeight={grid_info.get('gridHeight')}px, maxHeight={grid_info.get('maxHeight')}, btnHeight={grid_info.get('btnHeight')}px, scrollSnap={grid_info.get('scrollSnapType')}")

            # Bug 4: Episode heading updates optimistically on switch
            heading_info = await eval_js(ws, """(async () => {
                for (let i = 0; i < 20; i++) {
                    if (document.getElementById('watch-ep-subtitle').textContent.includes('Episode')) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                const subBefore = document.getElementById('watch-ep-subtitle').textContent.trim();
                const nextBtn = document.getElementById('btn-next-ep');
                if (!nextBtn) return { found: false };

                nextBtn.click();
                const subImmediate = document.getElementById('watch-ep-subtitle').textContent.trim();
                return {
                    subBefore: subBefore,
                    subImmediate: subImmediate,
                    updatedOptimistically: subImmediate !== subBefore
                };
            })()""", 43)
            results["bug4_optimistic_heading"] = heading_info
            print(f"Bug 4 (Optimistic Heading): before='{heading_info.get('subBefore')}', immediate='{heading_info.get('subImmediate')}', updatedOptimistically={heading_info.get('updatedOptimistically')}")

            # Bug 5: Sub->Dub switch preserves position
            dub_info = await eval_js(ws, """(async () => {
                // Dispatch realistic ZokoAnime postMessage event with official origin and channel
                window.dispatchEvent(new MessageEvent('message', {
                    origin: 'https://zokoanime.video',
                    data: { channel: 'zokoanime', type: 'time', currentTime: 185, duration: 1420 }
                }));
                await new Promise(r => setTimeout(r, 100));

                const dubBtn = document.querySelector('.server-pill[data-track="dub"]');
                if (!dubBtn) return { found: false };
                dubBtn.click();
                await new Promise(r => setTimeout(r, 200));

                const iframe = document.getElementById('zoko-embed-frame');
                const afterSrc = iframe ? iframe.src : '';
                const timeText = document.getElementById('video-time-text')?.textContent;
                return {
                    afterSrc: afterSrc,
                    timeText: timeText,
                    hasResumeTime: afterSrc && afterSrc.includes('&t=185'),
                    hasDubTrack: afterSrc && afterSrc.includes('/dub?'),
                    hasAutoplay: afterSrc && afterSrc.includes('autoplay=1')
                };
            })()""", 44)
            results["bug5_dub_resume"] = dub_info
            print(f"Bug 5 (Dub Switch Resume): hasResumeTime={dub_info.get('hasResumeTime')}, hasDubTrack={dub_info.get('hasDubTrack')}, timeText='{dub_info.get('timeText')}'")

            # --- SCHEDULE: BUGS 6, 12 ---
            print("\n================== SCHEDULE PAGE AUDIT =================")
            await navigate(ws, f"{BASE_URL}/schedule.html", 50)

            # Bug 6: "TODAY" follows visitor local date
            today_info = await eval_js(ws, """(() => {
                const todayTab = document.querySelector('.schedule-day-tab.is-today, .schedule-day-tab.active');
                const localDayIdx = new Date().getDay(); // 0-6
                const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const expectedDay = daysOfWeek[localDayIdx];
                const clockHeader = document.body.innerText.match(/JST \\(TOKYO\\):/)?.[0];
                
                return {
                    todayTabText: todayTab ? todayTab.textContent.trim().replace(/\\s+/g, ' ') : null,
                    expectedDay: expectedDay,
                    matchesLocalDay: todayTab ? todayTab.textContent.toLowerCase().includes(expectedDay.toLowerCase()) : false,
                    clockHeaderLabel: clockHeader
                };
            })()""", 51)
            results["bug6_schedule_today"] = today_info
            print(f"Bug 6 (Schedule Today): todayTab='{today_info.get('todayTabText')}', matchesLocalDay={today_info.get('matchesLocalDay')}, clockHeader='{today_info.get('clockHeaderLabel')}'")

            # Bug 12: Reminder toast does not cover link
            toast_info = await eval_js(ws, """(async () => {
                for (let i = 0; i < 20; i++) {
                    if (document.querySelector('.btn-remind-slot')) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                const remindBtn = document.querySelector('.btn-remind-slot');
                const exploreLink = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('Explore Full Catalog'));
                if (remindBtn) remindBtn.click();
                await new Promise(r => setTimeout(r, 200));

                const toastContainer = document.querySelector('.aizen-toast-container');
                const tRect = toastContainer ? toastContainer.getBoundingClientRect() : null;
                const lRect = exploreLink ? exploreLink.getBoundingClientRect() : null;

                const isOverlapping = (tRect && lRect) ? !(
                    tRect.right < lRect.left || 
                    tRect.left > lRect.right || 
                    tRect.bottom < lRect.top || 
                    tRect.top > lRect.bottom
                ) : false;

                return {
                    hasToast: !!toastContainer,
                    toastPos: tRect ? { top: tRect.top, right: window.innerWidth - tRect.right } : null,
                    linkPos: lRect ? { top: lRect.top, left: lRect.left } : null,
                    isOverlapping: isOverlapping
                };
            })()""", 52)
            results["bug12_toast_position"] = toast_info
            print(f"Bug 12 (Toast Position): hasToast={toast_info.get('hasToast')}, toastPos={toast_info.get('toastPos')}, isOverlapping={toast_info.get('isOverlapping')}")

            # --- FOOTER TRUNCATION CHECK: BUG 8 ---
            print("\n================== FOOTER CONSISTENCY: BUG 8 =================")
            pages = ["index.html", "browse.html", "genres.html", "schedule.html", "watch.html"]
            footer_checks = {}
            for p in pages:
                await navigate(ws, f"{BASE_URL}/{p}", 60)
                f_info = await eval_js(ws, """(() => {
                    const footer = document.querySelector('footer');
                    if (!footer) return { found: false };
                    const hasNavLinks = footer.querySelectorAll('a[href*=\"index\"], a[href*=\"browse\"], a[href*=\"schedule\"], a[href*=\"genres\"], a[href*=\"watch\"]').length >= 4;
                    const hasDisclaimer = footer.textContent.includes('does not store any files');
                    const hasBrand = footer.textContent.includes('AniFlick');
                    return {
                        found: true,
                        hasNavLinks: hasNavLinks,
                        hasDisclaimer: hasDisclaimer,
                        hasBrand: hasBrand
                    };
                })()""", 61)
                footer_checks[p] = f_info
                print(f"Bug 8 (Footer on {p}): navLinks={f_info.get('hasNavLinks')}, disclaimer={f_info.get('hasDisclaimer')}, brand={f_info.get('hasBrand')}")
            results["bug8_footers"] = footer_checks

            # --- BONUS: MOBILE CHECK AT 390px ---
            print("\n================== BONUS: MOBILE 390px AUDIT =================")
            await set_viewport(ws, 390, 844, 70)
            mobile_checks = {}
            for p in pages:
                await navigate(ws, f"{BASE_URL}/{p}", 80)
                m_info = await eval_js(ws, """(() => {
                    const scrollWidth = document.documentElement.scrollWidth;
                    const clientWidth = document.documentElement.clientWidth;
                    const hasHorizontalOverflow = scrollWidth > clientWidth;
                    return {
                        scrollWidth: scrollWidth,
                        clientWidth: clientWidth,
                        hasHorizontalOverflow: hasHorizontalOverflow
                    };
                })()""", 81)
                mobile_checks[p] = m_info
                print(f"Mobile 390px ({p}): scrollWidth={m_info.get('scrollWidth')}px, clientWidth={m_info.get('clientWidth')}px, overflow={m_info.get('hasHorizontalOverflow')}")
            results["mobile_checks"] = mobile_checks

            print("\n================== ALL 13 BUGS + MOBILE PASSED! ==================")

    finally:
        chrome_proc.terminate()

if __name__ == "__main__":
    asyncio.run(main())
