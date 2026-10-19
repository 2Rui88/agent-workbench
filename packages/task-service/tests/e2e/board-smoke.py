# CLI Session Task MCP — board smoke flow (browser-harness + Microsoft Edge).
#
# Reuses an existing tab at http://127.0.0.1:47321/board?repo=repo-e2e and drives the UI
# through the Accessibility Tree. Covers: create via the single entry button,
# detail drawer, priority edit, legacy imports (paused + pending_acceptance),
# human accept into the collapsed closed column, releasing the seeded stale
# session, and a pure SSE-refresh check (in-page fetch, EventSource-driven
# card appearance, no reload from this script).
#
# NOTE: the plan skeleton asserted a dialog named 任务详情; the reviewed UI
# titles the drawer 新建任务 in create mode and by task title in detail mode.
# This script asserts those real names (same role=dialog + aria-modal).

import json
import time

import os

BASE = os.environ.get("BOARD_URL", "http://127.0.0.1:47321")
BOARD = f"{BASE}/board?repo=repo-e2e"

open_or_switch_tab(BOARD)
# Background tabs get rAF-throttled to zero, which stalls Base UI popups
# (the board modal waits a frame before mounting). Bring the tab to the
# front so animations and mounts run at full speed.
cdp("Page.bringToFront")
js("location.reload()")
wait_for_load()
cdp("Page.bringToFront")


def find_ax(role, name):
    nodes = cdp("Accessibility.getFullAXTree")["nodes"]
    for node in nodes:
        role_value = node.get("role", {}).get("value")
        name_value = node.get("name", {}).get("value")
        if role_value == role and name_value == name:
            return node
    return None


def click_entry_mode(value):
    """Click the drawer's entry-mode radio (native input) via DOM."""
    ok = js(
        '(() => {'
        '  const radio = document.querySelector(\'input[name="entry-mode"][value="' + value + '"]\');'
        '  if (radio === null) return false;'
        '  radio.click();'
        '  return true;'
        '})()'
    )
    if ok is not True:
        raise AssertionError("entry-mode radio not found: " + value)


def find_ax_retry(role, name, timeout_seconds=5):
    """AX trees lag rapid React re-renders; poll briefly before giving up."""
    deadline = time.time() + timeout_seconds
    node = None
    while time.time() < deadline:
        node = find_ax(role, name)
        if node is not None:
            return node
        time.sleep(0.25)
    raise AssertionError(f"AX node not found: {role} {name}")


def click_ax(role, name):
    node = find_ax_retry(role, name)
    cdp("DOM.scrollIntoViewIfNeeded", backendNodeId=node["backendDOMNodeId"])
    box = cdp("DOM.getBoxModel", backendNodeId=node["backendDOMNodeId"])["model"]["content"]
    click_at_xy(sum(box[0::2]) / 4, sum(box[1::2]) / 4)


def click_button(name):
    """Click a text-named button via its live DOM rect.

    The AX tree lags React re-renders inside the modal, so a backendNodeId
    box can reflect a pre-layout position and the coordinate click lands on
    the backdrop (which closes the modal). Reading the rect from the live
    DOM right before clicking is immune to that staleness."""
    template = """
      (() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const btn = buttons.find((entry) =>
          (entry.textContent || "").trim() === NAME || entry.getAttribute("aria-label") === NAME);
        if (btn === undefined) return "not found";
        if (btn.disabled) return "disabled";
        // Scroll the modal's scroll area so the button is fully visible, then
        // click via DOM. Coordinate clicks are fragile here: overlays, focus
        // management, and animation can move the target between the rect read
        // and the dispatch, and an out-of-viewport dispatch counts as an
        // outside click and silently closes the modal.
        const scroller = btn.closest(".drawer-panel") ?? document.scrollingElement;
        const scrollerRect = scroller.getBoundingClientRect();
        const rect = btn.getBoundingClientRect();
        if (rect.bottom > scrollerRect.bottom) {
          scroller.scrollTop += rect.bottom - scrollerRect.bottom + 12;
        }
        const after = btn.getBoundingClientRect();
        window.__lastClick = {
          x: after.x + after.width / 2,
          y: after.y + after.height / 2,
          name: NAME,
          visible: after.bottom <= scrollerRect.bottom + 1 && after.top >= 0
        };
        btn.click();
        return true;
      })()
    """
    outcome = js(template.replace("NAME", json.dumps(name)))
    if outcome is not True:
        raise AssertionError(f"click_button({name}) failed: {outcome}")


def select_authored_option(trigger_selector, option_name):
    """Choose an option from the app-owned Select/Listbox primitive."""
    opened = js("""
      (() => {
        const trigger = document.querySelector(%s);
        if (trigger === null) return false;
        trigger.click();
        return true;
      })()
    """ % json.dumps(trigger_selector))
    if opened is not True:
        raise AssertionError(f"authored select trigger not found: {trigger_selector}")
    wait_until_js(
        f"document.querySelector({json.dumps(trigger_selector)}).getAttribute('aria-expanded') === 'true'"
        " && document.querySelector('[data-slot=select-content][data-open]') !== null",
        label=f"authored select opened: {trigger_selector}",
    )
    focused = js("""
      (() => {
        const option = Array.from(document.querySelectorAll(
          '[data-slot=select-content][data-open] [data-slot=select-item]'
        ))
          .find((entry) => (entry.textContent || '').trim() === %s);
        if (option === undefined) return false;
        option.focus();
        return document.activeElement === option;
      })()
    """ % json.dumps(option_name))
    if focused is not True:
        raise AssertionError(f"authored select option not found: {option_name}")
    dispatch_key("Enter", "Enter", 13)
    wait_until_js(
        f"document.querySelector({json.dumps(trigger_selector)}).getAttribute('aria-expanded') === 'false'"
        " && document.querySelector('[data-slot=select-content][data-open]') === null",
        label=f"authored select closed: {trigger_selector}",
    )


def dispatch_key(key, code, virtual_key_code, text=None):
    for event_type in ("keyDown", "keyUp"):
        event = {
            "type": event_type,
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": virtual_key_code,
            "nativeVirtualKeyCode": virtual_key_code,
        }
        if event_type == "keyDown" and text is not None:
            event["text"] = text
        cdp(
            "Input.dispatchKeyEvent",
            **event,
        )


def click_center_of(rect_expression):
    """Resolve a live DOM rectangle and click its center through CDP."""
    rect = json.loads(js(rect_expression))
    click_at_xy(rect["x"], rect["y"])


def wait_until_js(expression, timeout_seconds=10, label="condition"):
    deadline = time.time() + timeout_seconds
    last = None
    while time.time() < deadline:
        last = js(f"Boolean({expression})")
        if last:
            return
        time.sleep(0.25)
    probe = js("""
      (() => {
        const p = window.__lastClick;
        if (p === undefined) return "no click recorded";
        const el = document.elementFromPoint(p.x, p.y);
        return p.name + " @ " + Math.round(p.x) + "," + Math.round(p.y) + " -> " +
          (el === null ? "null" : el.tagName + "." + (el.className || "").toString().slice(0, 60) + " text=" + (el.textContent || "").trim().slice(0, 30));
      })()
    """)
    drawer_open = js("document.querySelector('.drawer-panel') !== null")
    raise AssertionError(
        f"timed out waiting for {label}: last value {last!r}; "
        f"element at last click: {probe}; drawer={drawer_open}"
    )


def close_drawer():
    """The accept/reject buttons keep the dialog open. Base UI's Modal listens
    for Escape on the document, so click the header close button instead."""
    if js("document.querySelector('.drawer-panel') !== null"):
        click_button("关闭抽屉")
    wait_until_js(
        "document.querySelector('.drawer-panel') === null", label="drawer closed"
    )


def poll_until(predicate, timeout_seconds=10, label="condition"):
    deadline = time.time() + timeout_seconds
    last = None
    while time.time() < deadline:
        last = predicate()
        if last:
            return
        time.sleep(0.25)
    probe = js("""
      (() => {
        const p = window.__lastClick;
        if (p === undefined) return "no click recorded";
        const el = document.elementFromPoint(p.x, p.y);
        return p.name + " @ " + Math.round(p.x) + "," + Math.round(p.y) + " -> " +
          (el === null ? "null" : el.tagName + " text=" + (el.textContent || "").trim().slice(0, 30));
      })()
    """)
    drawer_open = js("document.querySelector('.drawer-panel') !== null")
    raise AssertionError(
        f"timed out waiting for {label}: last value {last!r}; "
        f"element at last click: {probe}; drawer={drawer_open}"
    )


def set_color_scheme(scheme):
    cdp(
        "Emulation.setEmulatedMedia",
        features=[{"name": "prefers-color-scheme", "value": scheme}],
    )
    expected_dark = "true" if scheme == "dark" else "false"
    wait_until_js(
        "document.documentElement.classList.contains('dark') === " + expected_dark,
        label=f"{scheme} color scheme applied",
    )


CONTRAST_JS = """
(() => {
  const element = document.querySelector(%s);
  if (element === null) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  function parseColor(value) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "rgba(0, 0, 0, 0)";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
  }
  function composite(foreground, background) {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    return [
      (foreground[0] * foreground[3]
        + background[0] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[1] * foreground[3]
        + background[1] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[2] * foreground[3]
        + background[2] * background[3] * (1 - foreground[3])) / alpha,
      alpha,
    ];
  }
  function effectiveBackground(node) {
    const layers = [];
    for (let current = node; current instanceof Element; current = current.parentElement) {
      layers.push(parseColor(getComputedStyle(current).backgroundColor));
    }
    let result = [255, 255, 255, 1];
    for (const layer of layers.reverse()) result = composite(layer, result);
    return result;
  }
  function luminance(color) {
    const channels = color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  const style = getComputedStyle(element);
  const foreground = parseColor(style.color);
  const background = effectiveBackground(element);
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  return JSON.stringify({
    ratio,
    color: style.color,
    background: background.slice(0, 3).map(Math.round).join(","),
  });
})()
"""


def contrast_for(selector):
    raw = js(CONTRAST_JS % json.dumps(selector))
    if raw is None:
        raise AssertionError(f"contrast target missing: {selector}")
    return json.loads(raw)


def assert_contrast(selector, label, minimum=4.5):
    result = contrast_for(selector)
    assert result["ratio"] >= minimum, (
        f"{label} contrast {result['ratio']:.2f}:1 below {minimum}:1 "
        f"({result['color']} on rgb({result['background']}))"
    )
    return result


def semantic_contrast_matrix():
    matrix = json.loads(js("""
      (() => {
        const previous = document.querySelector('[data-contrast-matrix]');
        previous?.remove();
        const host = document.createElement('div');
        host.dataset.contrastMatrix = 'true';
        host.className = 'bg-popover';
        Object.assign(host.style, {
          position: 'fixed',
          left: '-10000px',
          top: '0',
          padding: '8px',
        });
        const cases = [
          ['primary-filled', 'bg-primary text-primary-foreground'],
          ['success-filled', 'bg-success text-success-foreground'],
          ['warning-filled', 'bg-warning text-warning-foreground'],
          ['destructive-filled', 'bg-destructive text-destructive-foreground'],
          ['info-filled', 'bg-info text-info-foreground'],
          ['success-soft', 'bg-success-soft text-success'],
          ['warning-soft', 'bg-warning-soft text-warning'],
          ['destructive-soft', 'bg-destructive-soft text-destructive'],
          ['info-soft', 'bg-info-soft text-info'],
          ['success-status', 'bg-success/15 text-success'],
          ['warning-status', 'bg-warning/15 text-warning'],
          ['destructive-status', 'bg-destructive/15 text-destructive'],
          ['info-status', 'bg-info/15 text-info'],
          ['outcome-passed', 'outcome outcome-passed'],
          ['outcome-failed', 'outcome outcome-failed'],
        ];
        for (const [name, classes] of cases) {
          const sample = document.createElement('span');
          sample.dataset.contrastCase = name;
          sample.className = classes;
          sample.textContent = name;
          host.append(sample);
        }
        document.body.append(host);
        return JSON.stringify(cases.map(([name]) => name));
      })()
    """))
    try:
        return {
            name: contrast_for(f'[data-contrast-case="{name}"]')
            for name in matrix
        }
    finally:
        js("document.querySelector('[data-contrast-matrix]')?.remove()")


def toast_semantic_matrix():
    return json.loads(js("""
      (() => {
        const previous = document.querySelector('[data-toast-matrix]');
        previous?.remove();
        const host = document.createElement('div');
        host.dataset.toastMatrix = 'true';
        Object.assign(host.style, {
          position: 'fixed',
          left: '-10000px',
          top: '0',
        });
        document.body.append(host);
        const cases = [
          [
            'default', null, 'bg-popover', 'text-foreground',
            'text-foreground-muted', 'text-foreground-muted',
          ],
          [
            'success', 'success', 'bg-success-soft', 'text-success',
            'text-success', 'text-success',
          ],
          [
            'error', 'destructive', 'bg-destructive-soft', 'text-destructive',
            'text-destructive', 'text-destructive',
          ],
          [
            'warning', 'warning', 'bg-warning-soft', 'text-warning',
            'text-warning', 'text-warning',
          ],
          [
            'info', 'info', 'bg-info-soft', 'text-info',
            'text-info', 'text-info',
          ],
        ];
        const result = {};
        for (const [
          type,
          semantic,
          surfaceClass,
          titleClass,
          descriptionClass,
          iconClass,
        ] of cases) {
          const toast = document.createElement('div');
          toast.dataset.sonnerToast = '';
          toast.dataset.type = type;
          toast.className = 'bg-popover text-popover-foreground';

          const title = document.createElement('span');
          title.dataset.title = '';
          title.className = 'text-foreground';
          title.textContent = type;
          toast.append(title);

          const description = document.createElement('span');
          description.dataset.description = '';
          description.className = 'text-foreground-muted';
          description.textContent = `${type} description`;
          toast.append(description);

          const icon = document.createElement('span');
          icon.dataset.icon = '';
          icon.className = 'bg-muted text-foreground-muted';
          icon.textContent = '!';
          toast.append(icon);

          const action = document.createElement('button');
          action.dataset.button = '';
          action.className = 'bg-primary text-primary-foreground';
          action.textContent = 'action';
          toast.append(action);
          host.append(toast);

          const surface = document.createElement('span');
          surface.className = surfaceClass;
          host.append(surface);
          const titleReference = document.createElement('span');
          titleReference.className = titleClass;
          host.append(titleReference);
          const descriptionReference = document.createElement('span');
          descriptionReference.className = descriptionClass;
          host.append(descriptionReference);
          const iconReference = document.createElement('span');
          iconReference.className = iconClass;
          host.append(iconReference);
          const actionReference = document.createElement('button');
          actionReference.className = 'bg-primary text-primary-foreground';
          host.append(actionReference);

          result[type] = {
            semantic,
            background: getComputedStyle(toast).backgroundColor,
            expectedBackground: getComputedStyle(surface).backgroundColor,
            titleColor: getComputedStyle(title).color,
            expectedTitleColor: getComputedStyle(titleReference).color,
            descriptionColor: getComputedStyle(description).color,
            expectedDescriptionColor: getComputedStyle(descriptionReference).color,
            iconColor: getComputedStyle(icon).color,
            expectedIconColor: getComputedStyle(iconReference).color,
            actionBackground: getComputedStyle(action).backgroundColor,
            expectedActionBackground: getComputedStyle(actionReference).backgroundColor,
            actionColor: getComputedStyle(action).color,
            expectedActionColor: getComputedStyle(actionReference).color,
          };
        }
        host.remove();
        return JSON.stringify(result);
      })()
    """))


def assert_toast_semantic_matrix(scheme):
    matrix = toast_semantic_matrix()
    for toast_type, colors in matrix.items():
        assert colors["background"] == colors["expectedBackground"], (
            f"{scheme} {toast_type} toast background is not its semantic surface: "
            f"{colors['background']} != {colors['expectedBackground']}"
        )
        for part, expected_part in (
            ("titleColor", "expectedTitleColor"),
            ("descriptionColor", "expectedDescriptionColor"),
            ("iconColor", "expectedIconColor"),
            ("actionBackground", "expectedActionBackground"),
            ("actionColor", "expectedActionColor"),
        ):
            assert colors[part] == colors[expected_part], (
                f"{scheme} {toast_type} toast {part} has the wrong semantic pair: "
                f"{colors[part]} != {colors[expected_part]}"
            )
    return matrix


FILL_JS = """
(() => {
  const label = %s;
  const value = %s;
  const fields = Array.from(document.querySelectorAll("label.field, label.inline-field"));
  const field = fields.find((entry) => {
    const caption = entry.querySelector(".field-label") ?? entry.querySelector("span");
    return caption !== null && caption.textContent.trim() === label;
  });
  if (!field) return "no such field: " + label;
  const input = field.querySelector("input, textarea, select");
  if (input === null) return "field has no input: " + label;
  const prototype = input instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()
"""


def fill(label, value):
    result = js(FILL_JS % (json.dumps(label), json.dumps(value)))
    if result is not True:
        raise AssertionError(f"fill failed for {label}: {result!r}")


CARD_IN_COLUMN_JS = """
(() => {
  const title = %s;
  const column = %s;
  const section = document.querySelector('section[aria-label="' + column + '"]');
  if (section === null) return false;
  const cards = Array.from(section.querySelectorAll("button.task-card"));
  return cards.some((entry) => {
    const caption = entry.querySelector(".task-card-title");
    return caption !== null && caption.textContent.trim() === title;
  });
})()
"""


def column_has(title, column):
    return js(CARD_IN_COLUMN_JS % (json.dumps(title), json.dumps(column))) is True


def click_task_card(title):
    ok = js("""
      (() => {
        const cards = Array.from(document.querySelectorAll("button.task-card"));
        const card = cards.find((entry) => {
          const caption = entry.querySelector(".task-card-title");
          return caption !== null && caption.textContent.trim() === %s;
        });
        if (card === undefined) return false;
        card.click();
        return true;
      })()
    """ % json.dumps(title))
    if ok is not True:
        raise AssertionError(f"task card not found: {title}")


# Pairing lands on the personal dashboard. Make the board entry explicit so
# this smoke flow does not depend on a remembered/default view.
if js("document.querySelector('.dashboard-page') !== null"):
    click_button("返回看板")
    wait_until_js(
        "document.querySelectorAll('section[aria-label]').length >= 4",
        label="board after leaving dashboard",
    )

# --- 1. Board loads with the seeded backlog content --------------------------
page_title = js("document.title")
assert "任务" in page_title, f"unexpected title {page_title!r}"
wait_until_js(
    "document.querySelectorAll('section[aria-label]').length >= 4", label="four columns"
)
theme_backgrounds = {}
for scheme, asset_name in (("light", "bg-light"), ("dark", "bg-dark")):
    set_color_scheme(scheme)
    theme_backgrounds[scheme] = js("getComputedStyle(document.body).backgroundImage")
    assert asset_name in theme_backgrounds[scheme], (
        f"{scheme} theme did not load {asset_name}: {theme_backgrounds[scheme]}"
    )
    assert js("getComputedStyle(document.body).backgroundSize") == "cover, 100%", (
        f"{scheme} background no longer scales to the viewport width"
    )
    assert js("getComputedStyle(document.body).backgroundAttachment") == "fixed, fixed", (
        f"{scheme} background no longer stays fixed"
    )
assert theme_backgrounds["light"] != theme_backgrounds["dark"], (
    "light and dark themes resolved to the same background"
)
poll_until(lambda: column_has("E2E 初始待执行任务", "待执行"), label="seeded backlog task")
board_filter_controls = json.loads(js("""
  JSON.stringify({
    native: document.querySelectorAll('.board-filters select').length,
    authored: document.querySelectorAll(
      '.board-filters [data-slot=select-trigger]'
    ).length
  })
"""))
assert board_filter_controls == {"native": 0, "authored": 2}, (
    f"board filters are not owned by authored Select: {board_filter_controls}"
)
priority_filter_selector = (
    '.board-filter-field [data-slot=select-trigger][aria-label="优先级"]'
)
js(f"document.querySelector({json.dumps(priority_filter_selector)}).focus()")
dispatch_key(" ", "Space", 32, text=" ")
wait_until_js(
    f"document.querySelector({json.dumps(priority_filter_selector)}).getAttribute('aria-expanded') === 'true'"
    " && document.querySelector('[data-slot=select-content][data-open]') !== null",
    label="priority filter opened by keyboard",
)
priority_filter_layout = json.loads(js("""
  (() => {
    const trigger = document.querySelector(%s);
    const popup = document.querySelector('[data-slot=select-content][data-open]');
    const triggerRect = trigger.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    return JSON.stringify({
      widthDelta: Math.abs(triggerRect.width - popupRect.width),
      inlineStartDelta: Math.abs(triggerRect.left - popupRect.left),
      optionCount: popup.querySelectorAll('[data-slot=select-item]').length
    });
  })()
""" % json.dumps(priority_filter_selector)))
assert priority_filter_layout["widthDelta"] <= 1, (
    f"priority filter popup width drifted: {priority_filter_layout}"
)
assert priority_filter_layout["inlineStartDelta"] <= 1, (
    f"priority filter popup is not aligned: {priority_filter_layout}"
)
assert priority_filter_layout["optionCount"] == 5, "priority options missing"
dispatch_key("Escape", "Escape", 27)
wait_until_js(
    f"document.querySelector({json.dumps(priority_filter_selector)}).getAttribute('aria-expanded') === 'false'"
    " && document.querySelector('[data-slot=select-content][data-open]') === null"
    f" && document.activeElement === document.querySelector({json.dumps(priority_filter_selector)})",
    label="priority filter escaped",
)
assert js(
    f"document.activeElement === document.querySelector({json.dumps(priority_filter_selector)})"
) is True, "priority filter did not restore focus after Escape"

js(f"document.querySelector({json.dumps(priority_filter_selector)}).focus()")
dispatch_key(" ", "Space", 32, text=" ")
wait_until_js(
    f"document.querySelector({json.dumps(priority_filter_selector)}).getAttribute('aria-expanded') === 'true'"
    " && document.querySelector('[data-slot=select-content][data-open]') !== null"
    " && document.activeElement?.getAttribute('data-slot') === 'select-item'",
    label="priority filter reopened by keyboard",
)
dispatch_key("ArrowDown", "ArrowDown", 40)
dispatch_key("Enter", "Enter", 13)
wait_until_js(
    f"document.querySelector({json.dumps(priority_filter_selector)}).getAttribute('aria-expanded') === 'false'"
    " && document.querySelector('[data-slot=select-content][data-open]') === null",
    label="priority filter selected by keyboard",
)
wait_until_js(
    f"document.querySelector({json.dumps(priority_filter_selector)}).textContent.includes('P0')",
    label="priority filter keyboard value",
)
select_authored_option(priority_filter_selector, "全部")

filter_viewport = page_info()
try:
    cdp(
        "Emulation.setDeviceMetricsOverride",
        width=640,
        height=max(800, filter_viewport["h"]),
        deviceScaleFactor=1,
        mobile=False,
    )
    js(f"document.querySelector({json.dumps(priority_filter_selector)}).click()")
    wait_until_js(
        f"document.querySelector({json.dumps(priority_filter_selector)}).getAttribute('aria-expanded') === 'true'"
        " && document.querySelector('[data-slot=select-content][data-open]')?.getBoundingClientRect().width > 0",
        label="narrow priority filter opened",
    )
    narrow_filter_layout = json.loads(js("""
      (() => {
        const trigger = document.querySelector(%s);
        const popup = document.querySelector('[data-slot=select-content][data-open]');
        const triggerRect = trigger.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        return JSON.stringify({
          widthDelta: Math.abs(triggerRect.width - popupRect.width),
          withinViewport: popupRect.left >= 0 && popupRect.right <= innerWidth
        });
      })()
    """ % json.dumps(priority_filter_selector)))
    assert narrow_filter_layout["widthDelta"] <= 1, (
        f"narrow priority filter popup width drifted: {narrow_filter_layout}"
    )
    assert narrow_filter_layout["withinViewport"], (
        f"narrow priority filter popup escaped viewport: {narrow_filter_layout}"
    )
    dispatch_key("Escape", "Escape", 27)
    wait_until_js(
        f"document.querySelector({json.dumps(priority_filter_selector)}).getAttribute('aria-expanded') === 'false'"
        " && document.querySelector('[data-slot=select-content][data-open]') === null",
        label="narrow priority filter escaped",
    )
finally:
    cdp("Emulation.clearDeviceMetricsOverride")

wait_until_js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]') !== null",
    label="main repository dependency reminder",
)
main_reminder_text = js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]')?.textContent ?? ''"
)
assert "冒烟新建任务" in main_reminder_text, "main repository reminder task missing"
assert "上游验收任务" in main_reminder_text, "main repository upstream title missing"
assert "第二项目任务" in main_reminder_text, "validation request upstream title missing"
assert "待验证" in main_reminder_text, "pending validation state missing"
assert "执行中" in main_reminder_text, "running validation status missing"
assert "已通过" in main_reminder_text, "passed validation status missing"
assert "已驳回" in main_reminder_text, "rejected validation status missing"
assert "跨仓库上游任务" not in main_reminder_text, "cross-repository reminder leaked"
assert js("""
  !Array.from(document.querySelectorAll('button')).some((button) => {
    const text = (button.textContent || '').trim();
    return text === '验证通过' || text === '验证驳回' || text === '提交验证';
  })
""") is True, "Board still exposes dependency validation response controls"

dependency_activity_layout = json.loads(js("""
  (() => {
    const tablist = document.querySelector('.dependency-notification-tabs');
    const tabs = Array.from(tablist?.querySelectorAll('[role=tab]') ?? []);
    const attentionPanel = document.querySelector(
      '[role=tabpanel][aria-label="待处理依赖动态"]'
    );
    const readPanel = document.querySelector(
      '[role=tabpanel][aria-label="已读依赖动态"]'
    );
    const firstActivity = attentionPanel?.querySelector('.dependency-notification');
    const tabRect = tabs[0]?.getBoundingClientRect();
    return JSON.stringify({
      tabCount: tabs.length,
      selected: tabs.map((tab) => tab.getAttribute('aria-selected')),
      panelHidden: [attentionPanel?.hidden, readPanel?.hidden],
      firstPending:
        firstActivity?.classList.contains('dependency-notification-validation-pending') === true,
      activePanelHasArchivedRead:
        attentionPanel?.querySelector(
          '.dependency-notification.is-read:not(.dependency-notification-validation-pending)'
        ) !== null,
      tabDisplay: tablist === null ? null : getComputedStyle(tablist).display,
      tabHeight: tabRect?.height ?? 0
    });
  })()
"""))
assert dependency_activity_layout["tabCount"] == 2, "dependency activity tabs missing"
assert dependency_activity_layout["selected"] == ["true", "false"], (
    "dependency activity did not default to the attention tab"
)
assert dependency_activity_layout["panelHidden"] == [False, True], (
    "dependency activity panels do not match the selected tab"
)
assert dependency_activity_layout["firstPending"], "pending validation is not pinned first"
assert not dependency_activity_layout["activePanelHasArchivedRead"], (
    "non-pending read history leaked into the attention tab"
)
assert dependency_activity_layout["tabDisplay"] == "inline-flex", "dependency tabs are not laid out"
assert dependency_activity_layout["tabHeight"] >= 32, "dependency tab target is too short"

click_center_of("""
  (() => {
    const tab = document.querySelectorAll('.dependency-notification-tabs [role=tab]')[1];
    const r = tab.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js(
    "document.querySelectorAll('.dependency-notification-tabs [role=tab]')[1]"
    "?.getAttribute('aria-selected') === 'true'",
    label="dependency read tab selected",
)
assert js(
    "document.querySelector('[role=tabpanel][aria-label=\"已读依赖动态\"]')?.hidden"
) is False, "read dependency history panel stayed hidden"
click_center_of("""
  (() => {
    const tab = document.querySelectorAll('.dependency-notification-tabs [role=tab]')[0];
    const r = tab.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js(
    "document.querySelectorAll('.dependency-notification-tabs [role=tab]')[0]"
    "?.getAttribute('aria-selected') === 'true'",
    label="dependency attention tab restored",
)

# Collapsing dependency activity is presentation-only: summary counts remain,
# the list hides, and no unread state is consumed.
dependency_summary_before = js("""
  (() => {
    const section = document.querySelector('section[aria-label="当前仓库依赖动态"]');
    return section?.querySelector('.dependency-notification-header')?.textContent ?? '';
  })()
""")
dependency_header_hot_area = json.loads(js("""
  (() => {
    const header = document.querySelector('.dependency-notification-header');
    const toggle = header?.querySelector('.dependency-notification-toggle');
    if (header === null || header === undefined || toggle === null || toggle === undefined) {
      return JSON.stringify({present: false});
    }
    const headerRect = header.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    return JSON.stringify({
      present: true,
      widthDelta: Math.abs(headerRect.width - toggleRect.width),
      heightDelta: Math.abs(headerRect.height - toggleRect.height),
      summaryInsideToggle:
        toggle.textContent.includes('未读') && toggle.textContent.includes('共 '),
    });
  })()
"""))
assert dependency_header_hot_area["present"], "dependency header toggle missing"
assert dependency_header_hot_area["widthDelta"] <= 1, (
    "dependency header is not fully covered by the toggle"
)
assert dependency_header_hot_area["heightDelta"] <= 1, (
    "dependency header toggle height does not cover the header"
)
assert dependency_header_hot_area["summaryInsideToggle"], (
    "dependency summary counts are outside the header hot area"
)
board_header_gradient = js("""
  getComputedStyle(
    document.querySelector('.dependency-notification-toggle')
  ).backgroundImage
""")
assert board_header_gradient != "none", "dependency header gradient missing"
assert js("""
  Array.from(document.querySelectorAll('.column-header')).every(
    (header) => getComputedStyle(header).backgroundImage === %s
  )
""" % json.dumps(board_header_gradient)) is True, (
    "task column headers do not share the dependency header gradient"
)
click_button("折叠依赖动态")
wait_until_js(
    "document.querySelector('.dependency-notification-list')?.hidden === true",
    label="dependency activity collapsed",
)
assert js(
    "document.querySelector('[aria-label=\"折叠依赖动态\"]') === null"
) is True, "collapsed dependency toggle kept the expanded label"
dependency_summary_collapsed = js("""
  (() => {
    const section = document.querySelector('section[aria-label="当前仓库依赖动态"]');
    return section?.querySelector('.dependency-notification-header')?.textContent ?? '';
  })()
""")
assert dependency_summary_collapsed == dependency_summary_before, (
    "dependency summary changed while collapsed"
)
click_button("展开依赖动态")
wait_until_js(
    "document.querySelector('.dependency-notification-list')?.hidden === false",
    label="dependency activity expanded",
)
assert js(
    "document.querySelector('[aria-label=\"折叠依赖动态\"]')?.getAttribute('aria-expanded')"
) == "true", "expanded dependency toggle did not restore aria-expanded"
assert js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]')"
    "?.textContent.includes('待验证')"
) is True, "dependency activity disappeared after expanding"

# --- 2. Seeded tasks land in their columns (creation lives in the CLI) ------
poll_until(lambda: column_has("冒烟新建任务", "待执行"), label="smoke-create in 待执行")
assert column_has("存量导入-已暂停", "待执行"), "paused legacy not in 待执行"
poll_until(
    lambda: column_has("E2E 待对话确认任务", "待处理"),
    label="waiting decision task in 待处理",
)
click_task_card("E2E 待对话确认任务")
assert find_ax("dialog", "E2E 待对话确认任务"), "waiting decision drawer did not open"
drawer_header_gradients = json.loads(js("""
  (() => {
    const selectors = [
      '.drawer-modal-header',
      '.drawer-section > h3',
      '.drawer-section > .section-header:first-child',
    ];
    return JSON.stringify(selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((header) => ({
        selector,
        backgroundImage: getComputedStyle(header).backgroundImage,
      }))
    ));
  })()
"""))
assert len(drawer_header_gradients) >= 2, "drawer container headers missing"
assert all(
    entry["backgroundImage"] == board_header_gradient
    for entry in drawer_header_gradients
), "drawer container headers do not share the board gradient"
decision_drawer = js("document.querySelector('.drawer-panel')?.textContent ?? ''")
assert "是否使用 SQLite？" in decision_drawer, "pending decision is not visible read-only"
assert "待决定" in decision_drawer, "pending decision heading is missing"
assert "记录人工决定" not in decision_drawer, "Board still exposes the decision form"
assert js("document.querySelector('.decision-form') === null") is True
assert js("""
  !Array.from(document.querySelectorAll('.drawer-panel button'))
    .some((button) => button.textContent.trim() === '记录决定')
""") is True, "Board still exposes the decision submit action"
close_drawer()

# --- 3. SSE-only refresh: in-page PATCH, no reload from this script ----------
task_id = js("""
  (() => {
    const card = Array.from(document.querySelectorAll('button.task-card'))
      .find((c) => c.querySelector('.task-card-title')?.textContent.trim() === '冒烟新建任务');
    return card === undefined ? null : card.dataset.taskId;
  })()
""")
assert task_id is not None, "smoke-create card id not found"
sse_patch = """
  window.__ssePatchOk = undefined;
  fetch('/api/tasks/TASK_ID')
    .then((response) => response.json())
    .then((detail) => fetch('/api/tasks/TASK_ID', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation_id: crypto.randomUUID(),
        expected_version: detail.task.version,
        priority: 'P0'
      })
    }))
    .then((response) => { window.__ssePatchOk = response.ok; })
    .catch(() => { window.__ssePatchOk = false; })
""".replace("TASK_ID", task_id)
js(sse_patch)
wait_until_js("window.__ssePatchOk === true", label="in-page priority PATCH")
# No reload from this script: the card must show P0 through the board's own
# EventSource -> detail re-fetch path.
wait_until_js(
    "Array.from(document.querySelectorAll('button.task-card'))"
    ".some((c) => c.textContent.includes('冒烟新建任务') && c.textContent.includes('P0'))",
    timeout_seconds=15,
    label="SSE-refreshed priority visible",
)

# --- 4. Seeded legacy imports sit in their columns ---------------------------
poll_until(lambda: column_has("存量导入-已暂停", "待执行"), label="paused legacy in 待执行")
poll_until(lambda: column_has("存量导入-待验收", "待处理"), label="acceptance legacy in 待处理")

# --- 4b. Project switcher and dashboard --------------------------------------
def click_center_of(selector_js):
    rect = js(selector_js)
    if rect is None:
        raise AssertionError("element not found for click: " + selector_js[:60])
    point = json.loads(rect)
    click_at_xy(point["x"], point["y"])


click_center_of("""
  (() => {
    const t = document.querySelector('.project-switch-trigger');
    const r = t.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js("document.querySelectorAll('[role=menuitem]').length >= 2", label="project menu open")
click_center_of("""
  (() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem]'))
      .find((e) => e.textContent.includes('项目仪表盘'));
    const r = item.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js("document.querySelectorAll('.dashboard-card').length >= 2", label="dashboard cards")
assert js("""
  (() => {
    const grid = document.querySelector('.dashboard-grid');
    if (grid === null) return false;
    return getComputedStyle(grid).gridTemplateColumns.trim().split(/\\s+/).length === 4;
  })()
""") is True, "dashboard project grid should use four desktop columns"
assert js("""
  Array.from(document.querySelectorAll('.dashboard-card-header')).every(
    (header) => getComputedStyle(header).backgroundImage === %s
  )
""" % json.dumps(board_header_gradient)) is True, (
    "dashboard card headers do not share the board gradient"
)
assert js("document.body.textContent.includes('3 条依赖提醒')") is True, "global unread count missing"
assert js("document.querySelectorAll('.dashboard-repo-attention').length >= 2") is True
assert js("""
  (() => {
    const row = Array.from(document.querySelectorAll('.dashboard-repo'))
      .find((entry) => entry.textContent.includes('repo-e2e'));
    const main = row?.querySelector('.dashboard-repo-main');
    const attention = row?.querySelector('.dashboard-repo-attention-grid');
    const owner = main?.querySelector('.dashboard-repo-owner');
    const badges = row === undefined ? [] : Array.from(
      row.querySelectorAll('.dashboard-repo-attention-grid [data-slot=badge]')
    );
    const dependency = badges.find((entry) => entry.textContent.startsWith('依赖'));
    const taskCount = badges.find((entry) => entry.textContent.startsWith('任务'));
    const overdue = badges.find((entry) => entry.textContent.startsWith('过期'));
    return attention !== undefined && attention !== null
      && owner !== undefined && owner !== null
      && getComputedStyle(attention).gridTemplateColumns.trim().split(/\\s+/).length === 3
      && !attention.textContent.includes('owner：')
      && owner.textContent.includes('owner：jande')
      && taskCount !== undefined && taskCount.textContent.includes('任务 6')
      && dependency !== undefined
      && getComputedStyle(dependency).backgroundColor !== getComputedStyle(taskCount).backgroundColor
      && overdue !== undefined
      && getComputedStyle(overdue).backgroundColor !== getComputedStyle(row).backgroundColor;
  })()
""") is True, "repository tags should be distinct and owner should stay below main info"
assert js("""
  (() => {
    const rows = Array.from(document.querySelectorAll('.dashboard-repo'));
    const main = rows.find((row) => row.textContent.includes('repo-e2e'));
    const second = rows.find((row) => row.textContent.includes('repo-e2e-2'));
    return main?.textContent.includes('依赖 2') === true
      && second?.textContent.includes('依赖 1') === true;
  })()
""") is True, "per-repository dependency badges missing"
dashboard_text = js("document.querySelector('.dashboard-page')?.textContent ?? ''")
assert "上游验收任务" not in dashboard_text, "dashboard leaked main reminder detail"
assert "跨仓库上游任务" not in dashboard_text, "dashboard leaked second reminder detail"
assert js("""
  (() => {
    const cards = Array.from(document.querySelectorAll('.dashboard-card'));
    const second = cards.find((c) => c.textContent.includes('E2E Second Project'));
    if (second === undefined) return false;
    return second.textContent.includes('Second Repo') && second.textContent.includes('任务 1');
  })()
""") is True, "second project card content mismatch"
# jump back into the main repo from the dashboard
click_center_of("""
  (() => {
    const row = Array.from(document.querySelectorAll('.dashboard-repo'))
      .find((r) => r.textContent.includes('repo-e2e-2'));
    const r = row.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
poll_until(lambda: column_has("第二项目任务", "待执行"), label="second project board view")
click_task_card("第二项目任务")
assert find_ax_retry("dialog", "第二项目任务"), "repair recovery drawer did not open"
repair_drawer_text = js("document.querySelector('.drawer-panel')?.textContent ?? ''")
assert "任务恢复" in repair_drawer_text, "recovery section missing"
assert "认领下游驳回并修复合同" in repair_drawer_text, "computed continuation missing"
assert "验证证据不完整" in repair_drawer_text, "repair rejection reason missing"
assert "等待上游 Agent 认领修复" in repair_drawer_text, "repair claim state missing"
assert "沿用旧合同导致下游验证失败" in repair_drawer_text, "failed attempt memory missing"
close_drawer()
wait_until_js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]') !== null",
    label="second repository dependency reminder",
)
second_reminder_text = js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]')?.textContent ?? ''"
)
assert "跨仓库上游任务" in second_reminder_text, "second repository reminder missing"
assert "上游验收任务" not in second_reminder_text, "main reminder leaked into second repository"
click_center_of("""
  (() => {
    const t = document.querySelector('.project-switch-trigger');
    const r = t.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js("document.querySelectorAll('[role=menuitem]').length >= 2", label="project menu reopen")
click_center_of("""
  (() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem]'))
      .find((e) => e.textContent.includes('E2E Project'));
    const r = item.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
poll_until(lambda: column_has("E2E 初始待执行任务", "待执行"), label="back to first project board")

# Dependency validation is Agent-owned: the Board only reads the seeded
# pending/running, passed, rejected, and retry/error history. There must be no
# response form or action button in the task drawer either.
click_task_card("冒烟新建任务")
assert find_ax_retry("dialog", "冒烟新建任务"), "smoke task drawer did not open"
assert js("""
  !Array.from(document.querySelectorAll('.drawer-panel button')).some((button) => {
    const text = (button.textContent || '').trim();
    return text === '验证通过' || text === '验证驳回' || text === '提交验证';
  })
""") is True, "task drawer exposes dependency validation response controls"
close_drawer()

# Mark the pending request read through the read-only activity affordance so
# the subsequent terminal-notification collapse remains deterministic.
js("""
  (() => {
    const item = document.querySelector('.dependency-notification-validation-pending');
    const button = item?.querySelector('button:not(.dependency-notification-open)');
    button?.click();
  })()
""")
wait_until_js(
    "document.querySelector('.dependency-notification-validation-pending.is-read') !== null",
    label="pending validation marked read",
)

# Opening the older terminal reminder marks it read without removing either
# the reminder or the already-processed validation row.
click_center_of("""
  (() => {
    const button = document.querySelector(
      '.dependency-notification-done .dependency-notification-open'
    );
    const r = button.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
assert find_ax_retry("dialog", "冒烟新建任务"), "dependency reminder did not open task"
wait_until_js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]')"
    "?.textContent.includes('未读') === false",
    label="opened dependency reminder marked read but retained",
)
wait_until_js(
    "document.querySelector('[aria-label=\"展开依赖动态\"]')"
    "?.getAttribute('aria-expanded') === 'false'",
    label="dependency activity collapsed after attention cleared",
)
assert js(
    "document.querySelector('section[aria-label=\"当前仓库依赖动态\"]')?.textContent.includes('共 4 条')"
) is True, "read dependency history disappeared"
close_drawer()
click_button("展开依赖动态")
click_center_of("""
  (() => {
    const tab = document.querySelectorAll('.dependency-notification-tabs [role=tab]')[1];
    const r = tab.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js(
    "document.querySelector('[role=tabpanel][aria-label=\"已读依赖动态\"]')"
    "?.querySelector('.dependency-notification-done.is-read') !== null",
    label="opened dependency reminder moved to read tab",
)
assert js(
    "document.querySelector('[role=tabpanel][aria-label=\"已读依赖动态\"]')"
    "?.querySelector('.dependency-notification-validation-passed.is-read') !== null"
) is True, "same-owner validation response remained unread"
assert js(
    "document.querySelector('[role=tabpanel][aria-label=\"已读依赖动态\"]')"
    "?.querySelector('.dependency-notification-validation-rejected.is-read') !== null"
) is True, "rejected validation history is not readable"

# A manual collapse remains stable until the active repository receives a
# different attention ID. Switching to the second repository supplies such an
# ID and must reopen the section on the attention tab.
click_button("折叠依赖动态")
click_center_of("""
  (() => {
    const t = document.querySelector('.project-switch-trigger');
    const r = t.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js("document.querySelectorAll('[role=menuitem]').length >= 2", label="project menu for auto expand")
click_center_of("""
  (() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem]'))
      .find((e) => e.textContent.includes('E2E Second Project'));
    const r = item.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
poll_until(lambda: column_has("第二项目任务", "待执行"), label="second project auto-expand view")
wait_until_js(
    "document.querySelector('[aria-label=\"折叠依赖动态\"]')"
    "?.getAttribute('aria-expanded') === 'true'"
    " && document.querySelectorAll('.dependency-notification-tabs [role=tab]')[0]"
    "?.getAttribute('aria-selected') === 'true'",
    label="new attention reopened dependency activity",
)
assert js(
    "document.querySelector('.dependency-notification-cancelled.is-unread') !== null"
) is True, "new second-repository attention item was not exposed"
assert js(
    "document.querySelector('.dependency-notification-validation-passed.is-unread') === null"
) is True, "same-owner response appeared unread in the upstream repository"

# Return to the main repository for the remaining task mutations.
click_center_of("""
  (() => {
    const t = document.querySelector('.project-switch-trigger');
    const r = t.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
wait_until_js("document.querySelectorAll('[role=menuitem]').length >= 2", label="project menu return after auto expand")
click_center_of("""
  (() => {
    const item = Array.from(document.querySelectorAll('[role=menuitem]'))
      .find((e) => e.textContent.includes('E2E Project'));
    const r = item.getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2});
  })()
""")
poll_until(lambda: column_has("E2E 初始待执行任务", "待执行"), label="main project restored after auto expand")
wait_until_js(
    "document.querySelector('[aria-label=\"展开依赖动态\"]')"
    "?.getAttribute('aria-expanded') === 'false'",
    label="read-only main dependency history collapsed again",
)
assert js(
    "document.querySelectorAll('.dependency-notification-tabs [role=tab]')[0]"
    "?.getAttribute('aria-selected') === 'true'"
) is True, "new-attention transition did not leave the attention tab selected"

# --- 5. Priority edit from the drawer ----------------------------------------
click_task_card("冒烟新建任务")
assert find_ax("dialog", "冒烟新建任务"), "detail drawer did not open"


def cancellation_dependency_layout():
    return json.loads(js("""
      (() => {
        const area = document.querySelector('.drawer-terminal-actions');
        const gate = area?.querySelector('.dependency-validation-gate');
        const button = area?.querySelector('.cancel-task-button');
        if (area === null || gate === null || button === null) {
          return JSON.stringify({present: false});
        }
        const areaRect = area.getBoundingClientRect();
        const gateRect = gate.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return JSON.stringify({
          present: true,
          disabled: button.disabled,
          text: gate.textContent,
          contained:
            gateRect.left >= areaRect.left
            && gateRect.right <= areaRect.right
            && buttonRect.left >= gateRect.left
            && buttonRect.right <= gateRect.right,
          noHorizontalOverflow: gate.scrollWidth <= gate.clientWidth
        });
      })()
    """))


default_cancel_gate = cancellation_dependency_layout()
viewport = page_info()
try:
    cdp(
        "Emulation.setDeviceMetricsOverride",
        width=640,
        height=max(800, viewport["h"]),
        deviceScaleFactor=1,
        mobile=False,
    )
    narrow_cancel_gate = cancellation_dependency_layout()
finally:
    cdp("Emulation.clearDeviceMetricsOverride")

for label, layout in (
    ("default", default_cancel_gate),
    ("narrow", narrow_cancel_gate),
):
    assert layout["present"], f"{label} cancellation dependency gate missing"
    assert layout["disabled"], f"{label} cancellation remains enabled with active upstreams"
    assert "等待以下直接上游完成或取消后" in layout["text"], (
        f"{label} cancellation dependency explanation missing"
    )
    assert "第二项目任务" in layout["text"], f"{label} backlog upstream is not named"
    assert "存量导入-待验收" in layout["text"], (
        f"{label} pending-acceptance upstream is not named"
    )
    assert layout["contained"], f"{label} cancellation gate escapes its action area"
    assert layout["noHorizontalOverflow"], f"{label} cancellation gate overflows horizontally"

js("window.__blockedCancel = undefined")
js("""
  fetch('/api/tasks/task-e2e-smoke-create')
    .then((response) => response.json())
    .then((detail) => fetch('/api/tasks/task-e2e-smoke-create/cancel', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        operation_id: 'op-e2e-blocked-cancel',
        expected_version: detail.task.version
      })
    }))
    .then(async (response) => {
      window.__blockedCancel = {
        status: response.status,
        body: await response.json()
      };
    })
    .catch((error) => {
      window.__blockedCancel = {status: 0, body: {message: String(error)}};
    })
""")
wait_until_js("window.__blockedCancel !== undefined", label="blocked cancellation response")
blocked_cancel = json.loads(js("JSON.stringify(window.__blockedCancel)"))
assert blocked_cancel["status"] == 409, (
    f"blocked cancellation returned {blocked_cancel['status']} instead of 409"
)
assert blocked_cancel["body"]["code"] == "ACTIVE_UPSTREAM_DEPENDENCY", (
    f"blocked cancellation returned unexpected body: {blocked_cancel['body']}"
)
assert sorted(blocked_cancel["body"]["evidence"]) == [
    "task-e2e-legacy-acceptance:pending_acceptance",
    "task-e2e-second-project:backlog",
], "blocked cancellation evidence does not name every active direct upstream"

select_authored_option(
    '.drawer-panel [data-slot=select-trigger][aria-label="优先级"]',
    "P1",
)
click_button("保存优先级")
close_drawer()
wait_until_js(
    "Array.from(document.querySelectorAll('button.task-card'))"
    ".some((c) => c.textContent.includes('冒烟新建任务') && c.textContent.includes('P1'))",
    label="priority edit applied",
)

# --- 6. Accept the pending_acceptance import → collapsed 已结束 --------------
click_task_card("存量导入-待验收")
assert find_ax("dialog", "存量导入-待验收"), "acceptance drawer did not open"


def dependency_acceptance_layout():
    return json.loads(js("""
      (() => {
        const gate = document.querySelector('.dependency-validation-gate');
        const buttons = document.querySelector('.acceptance-buttons');
        if (gate === null || buttons === null) {
          return JSON.stringify({present: false});
        }
        const gateRect = gate.getBoundingClientRect();
        const buttonsRect = buttons.getBoundingClientRect();
        const gateButton = gate.querySelector('button');
        const gateButtonRect = gateButton?.getBoundingClientRect();
        return JSON.stringify({
          present: true,
          verticalGap: buttonsRect.top - gateRect.bottom,
          nonOverlapping: buttonsRect.top >= gateRect.bottom,
          gateButtonContained:
            gateButtonRect !== undefined
            && gateButtonRect.left >= gateRect.left
            && gateButtonRect.right <= gateRect.right
            && gateButtonRect.top >= gateRect.top
            && gateButtonRect.bottom <= gateRect.bottom
        });
      })()
    """))


default_dependency_layout = dependency_acceptance_layout()
viewport = page_info()
try:
    cdp(
        "Emulation.setDeviceMetricsOverride",
        width=640,
        height=max(800, viewport["h"]),
        deviceScaleFactor=1,
        mobile=False,
    )
    narrow_dependency_layout = dependency_acceptance_layout()
finally:
    cdp("Emulation.clearDeviceMetricsOverride")

for label, layout in (
    ("default", default_dependency_layout),
    ("narrow", narrow_dependency_layout),
):
    assert layout["present"], f"{label} downstream validation gate missing"
    assert layout["nonOverlapping"], (
        f"{label} downstream validation gate overlaps acceptance buttons"
    )
    assert layout["verticalGap"] >= 8, (
        f"{label} downstream validation gap too small: {layout['verticalGap']}px"
    )
    assert layout["gateButtonContained"], (
        f"{label} downstream validation button escapes its container"
    )

acceptance_layout = json.loads(js("""
  (() => {
    const group = document.querySelector('.acceptance-buttons');
    if (group === null) return JSON.stringify({present: false});
    const buttons = Array.from(group.querySelectorAll('button'));
    const accept = buttons.find((button) => button.textContent.trim() === '验收通过');
    const reject = buttons.find((button) => button.textContent.trim() === '驳回');
    const actions = group.closest('.drawer-section');
    const drawerBody = group.closest('.drawer-body');
    const cancelArea = drawerBody.querySelector('.drawer-terminal-actions');
    const cancel = cancelArea?.querySelector('button');
    const events = drawerBody.querySelector('#drawer-events');
    if (
      accept === undefined
      || reject === undefined
      || cancel === null
      || cancel === undefined
      || cancelArea === null
      || events === null
    ) {
      return JSON.stringify({present: false});
    }
    const acceptRect = accept.getBoundingClientRect();
    const rejectRect = reject.getBoundingClientRect();
    const eventsRect = events.getBoundingClientRect();
    const cancelRect = cancel.getBoundingClientRect();
    const cancelStyle = getComputedStyle(cancel);
    const cancelAreaStyle = getComputedStyle(cancelArea);
    return JSON.stringify({
      present: true,
      sameParent: accept.parentElement === reject.parentElement,
      widthDelta: Math.abs(acceptRect.width - rejectRect.width),
      heightDelta: Math.abs(acceptRect.height - rejectRect.height),
      colorsDistinct:
        getComputedStyle(accept).backgroundColor
        !== getComputedStyle(reject).backgroundColor,
      cancelBelowAllSections: cancelRect.top > eventsRect.bottom,
      cancelOutsideActionSection: !actions.contains(cancel),
      cancelIsLastContent: drawerBody.lastElementChild === cancelArea,
      cancelNonFixed:
        cancelAreaStyle.position !== 'fixed'
        && cancelAreaStyle.position !== 'sticky',
      cancelOutlined:
        cancelStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && cancelStyle.borderTopColor === cancelStyle.color
    });
  })()
"""))
assert acceptance_layout["present"], "accept/reject decision buttons missing"
assert acceptance_layout["sameParent"], "accept/reject buttons are not peers"
assert acceptance_layout["widthDelta"] <= 1, "accept/reject widths differ"
assert acceptance_layout["heightDelta"] <= 1, "accept/reject heights differ"
assert acceptance_layout["colorsDistinct"], "accept/reject colors are not distinct"
assert acceptance_layout["cancelBelowAllSections"], "cancel action is not after all detail sections"
assert acceptance_layout["cancelOutsideActionSection"], "cancel action remains in manual actions"
assert acceptance_layout["cancelIsLastContent"], "cancel action is not the last drawer content"
assert acceptance_layout["cancelNonFixed"], "cancel action is fixed or sticky"
assert acceptance_layout["cancelOutlined"], "cancel action is not a red outline button"

for scheme in ("light", "dark"):
    set_color_scheme(scheme)
    contrast_matrix = semantic_contrast_matrix()
    for semantic_case, contrast in contrast_matrix.items():
        assert contrast["ratio"] >= 4.5, (
            f"{scheme} {semantic_case} contrast {contrast['ratio']:.2f}:1 "
            "below 4.5:1"
        )
    assert_contrast(
        ".acceptance-buttons button:first-child",
        f"{scheme} acceptance button",
    )
    toast_matrix = assert_toast_semantic_matrix(scheme)
    assert toast_matrix["success"]["titleColor"] != "rgb(255, 255, 255)", (
        f"{scheme} success toast still uses white title text"
    )

# Keep the action and first toast check in dark mode, matching the reported
# regression. The same live toast then flips to light without reenacting the
# acceptance operation.
set_color_scheme("dark")
click_button("验收通过")
wait_until_js(
    "document.querySelector('[data-sonner-toast] [data-title]') !== null",
    label="acceptance success toast",
)
wait_until_js(
    "document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme') === 'dark'",
    label="dark toaster theme",
)
assert_contrast("[data-sonner-toast] [data-title]", "dark acceptance toast")
assert_contrast("[data-sonner-toast] [data-icon]", "dark acceptance toast icon", 3.0)
dark_toast = json.loads(js("""
  (() => {
    const toast = document.querySelector('[data-sonner-toast]');
    const title = toast?.querySelector('[data-title]');
    if (toast === null || title === null) return JSON.stringify(null);
    return JSON.stringify({
      type: toast.dataset.type,
      background: getComputedStyle(toast).backgroundColor,
      titleColor: getComputedStyle(title).color,
    });
  })()
"""))
dark_expected_toast = toast_semantic_matrix()["success"]
assert dark_toast["type"] == "success", "acceptance toast is not a success toast"
assert dark_toast["background"] == dark_expected_toast["expectedBackground"], (
    "dark acceptance toast does not use the success semantic surface: "
    f"{dark_toast['background']} != {dark_expected_toast['expectedBackground']}"
)
assert dark_toast["titleColor"] == dark_expected_toast["expectedTitleColor"], (
    "dark acceptance toast does not use the success semantic foreground: "
    f"{dark_toast['titleColor']} != {dark_expected_toast['expectedTitleColor']}"
)
assert dark_toast["titleColor"] != "rgb(255, 255, 255)", (
    "dark acceptance toast still uses white title text"
)

set_color_scheme("light")
wait_until_js(
    "document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme') === 'light'",
    label="light toaster theme",
)
assert_contrast("[data-sonner-toast] [data-title]", "light acceptance toast")
assert_contrast("[data-sonner-toast] [data-icon]", "light acceptance toast icon", 3.0)
light_toast = json.loads(js("""
  (() => {
    const toast = document.querySelector('[data-sonner-toast]');
    const title = toast?.querySelector('[data-title]');
    if (toast === null || title === null) return JSON.stringify(null);
    return JSON.stringify({
      background: getComputedStyle(toast).backgroundColor,
      titleColor: getComputedStyle(title).color,
    });
  })()
"""))
light_expected_toast = toast_semantic_matrix()["success"]
assert light_toast["background"] == light_expected_toast["expectedBackground"], (
    "light acceptance toast does not use the success semantic surface: "
    f"{light_toast['background']} != {light_expected_toast['expectedBackground']}"
)
assert light_toast["titleColor"] == light_expected_toast["expectedTitleColor"], (
    "light acceptance toast does not use the success semantic foreground: "
    f"{light_toast['titleColor']} != {light_expected_toast['expectedTitleColor']}"
)
set_color_scheme("dark")

poll_until(
    lambda: not column_has("存量导入-待验收", "待处理"),
    label="task left 待处理 after accept",
)
close_drawer()
# 已结束 is collapsed by default; expand it and the card must appear.
closed_toggle = js("""
  (() => {
    const button = document.querySelector(
      'section[aria-label="已结束"] > button.column-header'
    );
    if (button === null) return false;
    if (button.getAttribute('aria-expanded') !== 'true') {
      button.click();
    }
    return true;
  })()
""")
assert closed_toggle is True, "closed-column expand button missing"
poll_until(
    lambda: column_has("存量导入-待验收", "已结束"),
    label="accepted task in collapsed 已结束 after expanding",
)

# --- 7. Release the seeded stale session from its drawer ---------------------
stale_column_toggle = js("""
  (() => {
    const button = document.querySelector(
      'section[aria-label="进行中"] > button.column-header'
    );
    if (button === null) return false;
    if (button.getAttribute('aria-expanded') !== 'true') {
      button.click();
    }
    return true;
  })()
""")
assert stale_column_toggle is True, "in-progress column expand button missing"
wait_until_js(
    "Array.from(document.querySelectorAll('button.task-card .task-card-title'))"
    ".some((entry) => entry.textContent.trim() === 'E2E 失联任务')",
    label="stale task visible after expanding its column",
)
click_task_card("E2E 失联任务")
assert find_ax("dialog", "E2E 失联任务"), "stale task drawer did not open"
click_button("释放 Session")
assert find_ax("dialog", "确认释放 Session？"), "release confirmation did not open"
click_button("确认释放 Session")
js("window.__staleStatus = undefined; window.__staleSession = undefined")
js("""
  fetch('/api/tasks/task-e2e-stale')
    .then((response) => response.json())
    .then((detail) => {
      window.__staleStatus = detail.task.status;
      window.__staleSession = detail.task.session_id ?? "";
    })
    .catch(() => { window.__staleStatus = 'error'; })
""")
wait_until_js("window.__staleStatus !== undefined", label="stale detail fetch")
status = js("window.__staleStatus")
assert status == "paused", f"stale task not paused after release (got {status!r})"
# paused tasks hold no lease (the release dropped it); the visible outcome is
# the card moving out of 进行中 into 待执行.
poll_until(
    lambda: column_has("E2E 失联任务", "待执行")
    and not column_has("E2E 失联任务", "进行中"),
    label="released stale task moved to 待执行",
)

# --- 8. Pairing instruction uses the canonical non-resizable Textarea -------
js("window.__logoutStatus = undefined")
js("""
  fetch('/api/board-auth/logout', {method: 'POST'})
    .then((response) => { window.__logoutStatus = response.status; })
    .catch(() => { window.__logoutStatus = 0; })
""")
wait_until_js("window.__logoutStatus !== undefined", label="board logout completed")
assert js("window.__logoutStatus") == 204, "board logout did not return 204"
js("location.reload()")
wait_for_load()
wait_until_js(
    "document.body.innerText.includes('此设备尚未初始化 Board')",
    label="board auth gate after logout",
)
click_button("生成一次性配对码")
wait_until_js(
    "document.querySelector('[data-slot=textarea]') !== null",
    label="pairing instruction textarea",
)
textarea_viewport = page_info()
try:
    cdp(
        "Emulation.setDeviceMetricsOverride",
        width=640,
        height=max(800, textarea_viewport["h"]),
        deviceScaleFactor=1,
        mobile=False,
    )
    pairing_textarea_layout = json.loads(js("""
      (() => {
        const textarea = document.querySelector('[data-slot=textarea]');
        const owner = textarea.closest('.board-agent-instruction');
        const textareaRect = textarea.getBoundingClientRect();
        const ownerRect = owner.getBoundingClientRect();
        return JSON.stringify({
          resize: getComputedStyle(textarea).resize,
          height: textareaRect.height,
          contained: textareaRect.left >= ownerRect.left && textareaRect.right <= ownerRect.right,
          noHorizontalOverflow: textarea.scrollWidth <= textarea.clientWidth
        });
      })()
    """))
    assert pairing_textarea_layout["resize"] == "none", (
        f"pairing textarea remains resizable: {pairing_textarea_layout}"
    )
    assert pairing_textarea_layout["height"] >= 52, (
        f"pairing textarea is too short: {pairing_textarea_layout}"
    )
    assert pairing_textarea_layout["contained"], (
        f"pairing textarea escapes its owner: {pairing_textarea_layout}"
    )
    assert pairing_textarea_layout["noHorizontalOverflow"], (
        f"pairing textarea overflows horizontally: {pairing_textarea_layout}"
    )
finally:
    cdp("Emulation.clearDeviceMetricsOverride")

print(
    "board-smoke: PASS (read-only Agent decisions, dependency validation/read "
    "history, cancellation dependency gate, seeded views, SSE refresh, "
    "authored selects, pairing textarea, priority, final acceptance, stale release)"
)
