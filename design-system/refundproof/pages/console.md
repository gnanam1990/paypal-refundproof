# Console Page Overrides

> **PROJECT:** RefundProof
> **Generated:** 2026-11-12 21:33:19
> **Page Type:** General

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** 1200px (standard)
- **Layout:** Full-width sections, centered content

### Spacing Overrides

- No overrides — use Master spacing

### Typography Overrides

- **Display and body:** Instrument Sans, 400/500/600 only
- **Identifiers and amounts:** DM Mono, 400/500 only
- Sentence case throughout; no tracked all-caps labels

### Color Overrides

- **Taste deal:** `teal-on-paper` for a fintech product
- **Background:** `#F7F9F8`
- **Surface:** `#FFFFFF` and `#EBF0EE`
- **Ink / action:** `#06525C`
- **Muted ink:** `#2F737D`
- Keep the console 90–95% neutral; spend colour on provider state and the primary action
- No violet, gradients, glass or resting shadows

### Component Overrides

- Avoid: Leave UI frozen with no feedback
- Avoid: Make dragging the only way to reorder resize or select
- Sharp radius scale: 4px controls, 6px panels, 8px dialogs
- Quiet one-pixel panel borders; no nested card decoration
- Status colour must always include an icon and text

---

## Page-Specific Components

- Full-width refund workflow answering the screen’s primary question
- Stable sidebar on desktop, compact top navigation on phone
- Evidence, capture, proposal and provider state retain their existing product hierarchy

---

## Recommendations

- Effects: Flat colour, no decorative imagery or scroll choreography on the app screen
- Animation: Quiet hover/press feedback and skeleton states only
- Accessibility: Add buttons menus or tap-to-move controls and retain keyboard operation
