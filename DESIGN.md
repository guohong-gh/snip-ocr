---
name: snip-ocr · Proofing Table
description: A local Windows screenshot, pin, and OCR utility styled as a print proofing table.
colors:
  proofing-paper: "#F4F5F1"
  raised-plate: "#FBFCF8"
  ink: "#181A17"
  ink-muted: "#565B54"
  ink-faint: "#666B63"
  signal-blue: "#2456B8"
  signal-blue-deep: "#1B4699"
  proof-vermilion: "#C33D26"
  success-green: "#2F6B4F"
  warning-ochre: "#9A6A1E"
  danger-red: "#B33A32"
  graphite-board: "#191C1E"
  graphite-plate: "#202427"
  graphite-ink: "#ECEDE7"
  graphite-muted: "#AEB3AA"
  graphite-faint: "#8A9085"
  graphite-signal: "#8FB3FF"
  graphite-signal-hover: "#B4CCFF"
  graphite-proof: "#FF8468"
  overlay-selection-blue: "#4F7CFF"
  overlay-rule: "rgba(255, 255, 255, 0.18)"
  overlay-highlight: "rgba(255, 255, 255, 0.95)"
  overlay-shadow: "rgba(0, 0, 0, 0.3)"
  pin-ink: "#F2F2EC"
  pin-strip: "rgba(20, 21, 23, 0.86)"
  pin-close: "rgba(20, 21, 23, 0.82)"
  pin-tag-rule: "rgba(143, 179, 255, 0.4)"
  pin-dim: "rgba(242, 242, 236, 0.7)"
typography:
  headline:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "9.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.04em"
  body-large:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  caption-small:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
  small-label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
  micro-label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.4
  micro:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.4
  micro-tiny:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "9px"
    fontWeight: 400
    lineHeight: 1.4
  overlay-label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "8.5px"
    fontWeight: 400
    lineHeight: 1.2
  badge:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "7.5px"
    fontWeight: 600
    lineHeight: 1.2
  close-glyph:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1
rounded:
  shell: "8px"
  plate: "3px"
  control: "2px"
  micro: "1px"
spacing:
  unit: "4px"
  titlebar: "44px"
  settings-header: "54px"
  plate-padding: "20px"
  section: "18px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.proofing-paper}"
    rounded: "{rounded.control}"
    padding: "0 12px"
  button-primary-dark:
    backgroundColor: "{colors.graphite-signal}"
    textColor: "#0E1A2E"
    rounded: "{rounded.control}"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.raised-plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  nav-item:
    backgroundColor: "{colors.raised-plate}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 10px"
---

# Design System: snip-ocr · Proofing Table

## Overview

**Creative North Star: "The Proofing Table"**

snip-ocr is a screenshot tool, so its interface borrows from the place where captured material gets inspected: a print proofing table. Paper and ink carry the surface; crop marks, registration ticks, plate-like panels, and mono metadata carry the precision. The tool should feel like an instrument that is already calibrated, not like a launcher with a decorative theme.

The world is deliberately flat. Separation comes from 1px rules, tonal paper layers, and whitespace, not stacked cards or shadows. Blue is the only interactive signal; vermilion marks unfinished or risky material. Every screen is built inside the fixed 680×560 window and follows the Windows light/dark setting.

**Key Characteristics:**
- Neutral proofing paper in light mode, graphite board in dark mode.
- One signal blue for primary actions, selection, and focus; vermilion only for proof/attention states.
- Hairline rules and small radii; no gradients, glass, or decorative grids.
- Crop-mark corners and a measurement ruler as the signature composition.
- System sans for language; mono only for versions, shortcuts, counts, and dimensions.

## Colors

Restrained by design: a paper/ink neutral stack, one interactive signal, and a proof accent that never becomes decoration.

### Primary
- **Registration Blue** (`#2456B8`, dark `#8FB3FF`): primary buttons, active navigation, focus rings, links, and selected cards. It is the only color that means “act or selected”.
- **Deep Registration Blue** (`#1B4699`): hover state on blue in light mode.

### Secondary
- **Proof Vermilion** (`#C33D26`, dark `#FF8468`): unfinished-feature badges, destructive outline buttons, and error-adjacent proof marks. Never used for ordinary emphasis.

### Neutral
- **Proofing Paper** (`#F4F5F1`) and **Raised Plate** (`#FBFCF8`): app ground and inset work surfaces.
- **Ink** (`#181A17`), **Ink Muted** (`#565B54`), **Ink Faint** (`#666B63`): primary, secondary, and metadata text. Ink Faint is tuned to stay at or above 4.5:1 on both paper surfaces.
- **Graphite Board** (`#191C1E`) and **Graphite Plate** (`#202427`): dark-mode ground and work surfaces.
- **Graphite Ink** (`#ECEDE7`), **Graphite Muted** (`#AEB3AA`), **Graphite Faint** (`#8A9085`): dark-mode text stack.

### Named Rules
**The One Signal Rule.** Blue is reserved for interaction and selection. If a blue element cannot be clicked, selected, or focused, it is the wrong color.

**The Vermilion Is Proof Rule.** Vermilion appears only where something is unfinished, destructive, or being proven. It is never a second brand accent.

## Typography

**Body Font:** Segoe UI Variable Text / Microsoft YaHei UI, with PingFang SC fallback.
**Label/Mono Font:** Cascadia Mono / Consolas, with ui-monospace fallback.

**Character:** A working UI voice: compact, neutral, and legible at 9–13px. The mono face is data, not costume; it carries versions, shortcuts, counts, dimensions, and pin readouts.

### Hierarchy
- **Headline** (600, 25px, 1.2): only the home capture invitation.
- **Title** (600, 15px, 1.3): settings page title and section-leading labels.
- **Body** (400, 13px, 1.55): descriptions, OCR text, and normal content.
- **Body large / small** (400, 13.5 / 12.5px): primary button labels and compact controls.
- **Label** (400, 9.5px, mono): versions, shortcut chips, pin dimensions, counters, and other measured data.
- **Micro scale** (9 / 10 / 10.5 / 11 / 11.5 / 12px): metadata, captions, field hints, and compact button labels.
- **Overlay scale** (7.5 / 8.5 / 16px): toolbar badge, language chip, and close glyph in the screenshot overlay.

## Layout

The app is a single fixed 680×560 content window. A 44px titlebar and a 30px footer bracket the work area. The home body is one inset capture plate with 20px horizontal padding and crop marks at the corners; the primary action is 356px wide and 52px tall, followed by a three-cell spec strip. Settings replace the home body with a 54px header, a 164px vertical category rail, and a scrolling content pane. Spacing follows a 4px base; section separation is 18px, control padding is 8–12px, and nothing depends on fluid type.

## Elevation & Depth

The system is flat at rest. Depth is tonal: paper, plate, and ink lines create layers. Shadows are reserved for things that leave the page: the title menu, toast, OCR sidebar, and the overlay toolbar. The frameless window relies on the OS shadow; no CSS window shadow is drawn.

### Shadow Vocabulary
- **Menu** (`0 10px 28px rgba(0, 0, 0, 0.18)`): titlebar menu and toast.
- **Overlay** (`0 18px 48px rgba(0, 0, 0, 0.24)`): OCR sidebar above the capture mask.

## Shapes

A precision silhouette: 8px shell, 3px plates, 2px controls, 1px rules. Buttons are rectangles, never pills. Crop-mark corners are 11px L-shapes, 1px weight; card corner marks are 7px. The grid is not painted; structure comes from rules, crop marks, and the ruler.

## Components

### Buttons
- **Shape:** 2px radius; primary capture action is 3px radius, 52px tall.
- **Primary:** signal blue fill, on-signal text, mono hotkey chip on the right. In dark mode, the signal is light blue with a dark label.
- **Hover / Focus:** 140ms ease-out; hover deepens the signal, focus uses a 2px signal outline with 2px offset.
- **Secondary / Ghost:** transparent with a 1px rule border; hover adds a signal tint.

### Inputs / Fields
- **Style:** raised plate, 1px rule border, 2px radius, mono value.
- **Focus:** 2px signal outline, 2px offset; recording state switches to vermilion.
- **Error / Disabled:** vermilion text for errors; 40% opacity and no pointer action when disabled.

### Cards / Containers
- **Corner Style:** 2px for controls and icon tiles, 3px for plates.
- **Background:** raised plate; active selection uses a 10% signal tint.
- **Shadow Strategy:** none at rest; see Elevation.
- **Border:** 1px rule, 1px signal when selected.
- **Internal Padding:** 8–14px.

### Navigation
- Settings uses a vertical rail of 2px-radius text buttons. Active state is a raised plate with a 1px signal left edge and semibold ink. Hover is a neutral wash. Labels stay plain text; no numbering or eyebrow labels.

### Capture Plate (signature)
The home work area is one inset plate with four crop-mark corners, a top status line, the capture invitation, the primary action, a three-cell spec strip, and a bottom ruler. The corner marks settle inward 2px on hover; the motion is removed under `prefers-reduced-motion`.

### Pin Strip (signature)
Pinned screenshots use a graphite measurement strip: `PIN`, image dimensions in mono, zoom percentage at the right, and a 20×20 close control. The strip is theme-invariant because it sits over arbitrary screenshots.

## Motion

State transitions are 140ms ease-out; the OCR sidebar and title menu use 160ms. No entrance choreography, parallax, or decorative loops. `prefers-reduced-motion` reduces every transition and animation to near-instant.

## Accessibility

Body and metadata text meet 4.5:1 in both themes; large headline text exceeds 3:1. Every interactive element has a visible focus ring. The pin close target remains 20×20 at the top-right hit point, and all titlebar controls keep a minimum 28×28 hit area. Keyboard paths (Alt+A, Alt+P, Escape, Ctrl+0) are unchanged.

## Do's and Don'ts

### Do:
- **Do** keep blue for interaction and selection only.
- **Do** use 1px rules and tonal layers to separate regions.
- **Do** set versions, shortcuts, counts, and dimensions in mono.
- **Do** keep the three-cell spec strip labels verbatim (`贴图 N 张`, `确定 复制`, `贴图 <hotkey>`).
- **Do** preserve the 20×20 pin close hit area and the 680×560 window.

### Don't:
- **Don't** reintroduce purple, gradients, glass, or pill-shaped CTAs.
- **Don't** add eyebrow labels, numbered sections, or decorative grid backgrounds.
- **Don't** use vermilion as a second accent for ordinary emphasis.
- **Don't** add card shadows or nested cards.
- **Don't** use mono for prose or decorative labels.
