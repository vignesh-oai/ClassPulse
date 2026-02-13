# Class Pulse Roster UI Guidelines

## Design thesis
Class Pulse should feel calm, professional, and fast for daily teacher workflows. Visual hierarchy should prioritize attendance state and action clarity over decorative branding. Color is semantic first: present, absent, and unmarked must always read instantly without visual noise. Surfaces should feel light and tactile, with restrained depth and clear focus states. Motion should support confidence, not attention-seeking.

## Brand and interaction rules
- Base look: neutral canvas, soft card surfaces, subtle borders.
- Semantic color priority:
  - Present: green family
  - Absent: rose/red family
  - Unmarked: amber family
- Brand accents: minimal and only for non-semantic emphasis.
- Type rhythm:
  - Title: semibold, compact
  - Body: regular, high readability
  - Metadata: smaller, lower contrast
- Action hierarchy:
  - Per-row state action is primary.
  - Destructive actions are isolated and explicit.
  - Secondary actions remain quiet.
- Focus states:
  - Inputs and buttons must show clear, non-flashy focus rings.

## Token plan
Use CSS variables for consistency and maintainability:
- Surface: `--cp-bg-app`, `--cp-bg-card`, `--cp-bg-muted`
- Border: `--cp-border`, `--cp-border-strong`
- Text: `--cp-text`, `--cp-text-muted`
- Semantic: `--cp-present-*`, `--cp-absent-*`, `--cp-unmarked-*`
- Action states: `--cp-action-primary`, `--cp-action-danger`, focus ring colors
- Shape and depth: `--cp-radius-*`, `--cp-shadow-*`

## Usage guide
- Keep container and section backgrounds neutral.
- Use semantic tints at the row level only.
- Keep summary chips simple and consistent in size/weight.
- Avoid saturated gradients in operational sections.
- Use initials/avatar as supporting identity, not a focal highlight.

## Current UI critique
What works:
- Attendance actions are explicit and discoverable.
- Row-level status tinting supports quick scanning.
- Summary counts are visible near the top.

What to improve:
- Decorative violets/fuchsia in header/footer compete with status colors.
- Too many simultaneous accents reduce calmness during repeated daily use.
- Hardcoded colors in component logic make it harder to tune and keep coherent.
- Inputs/buttons use mixed visual language; controls should feel more unified.
