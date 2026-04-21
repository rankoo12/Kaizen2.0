# Kaizen — Frontend UI Specification
### Version 1.0 | Next.js 15 · Tailwind v4 · Atomic Design

*This spec governs the Kaizen frontend. It defines the design system, component hierarchy, page contracts, and file layout. All component implementations are derived from this document — not from the raw Figma HTML exports. The HTML exports in `docs/UI/raw_html/` are visual references only.*

---

## Table of Contents

1. [Tech Stack](#1-tech-stack)
2. [Project Structure](#2-project-structure)
3. [Design Tokens](#3-design-tokens)
4. [Atomic Design Hierarchy](#4-atomic-design-hierarchy)
   - 4.1 [Atoms](#41-atoms)
   - 4.2 [Molecules](#42-molecules)
   - 4.3 [Organisms](#43-organisms)
5. [Pages](#5-pages)
6. [Component Contracts](#6-component-contracts)
7. [Routing](#7-routing)
8. [Conventions](#8-conventions)

---

## 1. Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router) | File-based routing, RSC-first |
| Styling | Tailwind CSS v4 | CSS-first config via `@theme` |
| Icons | lucide-react | Tree-shakeable, consistent with designs |
| Fonts | next/font/google | Inter (body), Space Grotesk (logo/brand), Manrope (hero) |
| Language | TypeScript strict | All props typed, no `any` |
| Components | Pure presentation | No fetch/API calls in this spec — all data via props |

---

## 2. Project Structure

```
packages/web/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── layout.tsx                # Root layout — font injection, global css
│   │   ├── globals.css               # Tailwind @import + custom scrollbar
│   │   ├── page.tsx                  # / → WelcomePage
│   │   ├── login/
│   │   │   └── page.tsx              # /login → LoginPage
│   │   ├── signup/
│   │   │   └── page.tsx              # /signup → SignupPage
│   │   └── tests/
│   │       └── new/
│   │           └── page.tsx          # /tests/new → NewTestPage
│   └── components/
│       ├── atoms/                    # Indivisible UI primitives
│       ├── molecules/                # Composed from atoms; one clear responsibility
│       └── organisms/               # Feature-complete sections composed from molecules
├── tailwind.config.ts
├── next.config.ts
├── tsconfig.json
└── package.json
```

---

## 3. Design Tokens

All tokens are defined once in `tailwind.config.ts` and consumed via Tailwind utility classes throughout the codebase. No inline hex values in component files.

### Colors

| Token | Value | Usage |
|---|---|---|
| `app-bg` | `#18121d` | Page background (login, signup, new-test) |
| `welcome-bg` | `#130d17` | Page background (welcome/landing only) |
| `card-bg` | `#231b29` | Cards, panels, dropdowns |
| `input-bg` | `#18121d` | All input fields |
| `border-subtle` | `rgba(255,255,255,0.0625)` | Borders, dividers |
| `brand-orange` | `#d5601c` | Primary CTA, active nav underline |
| `brand-orange-light` | `#e59365` | Orange gradient start (login button) |
| `brand-pink` | `#db87af` | Secondary accent, step numbers, badges |
| `brand-pink-light` | `#ebd1de` | Pink gradient start (signup button) |
| `brand-pink-mid` | `#d498b6` | Pink gradient end |
| `brand-yellow` | `#f59e0b` | Run Test button gradient end |
| `brand-accent` | `#c17741` | Section headings, focused textarea text |
| `brand-red` | `#ef4444` | Destructive actions, logout |

### Typography

| Token | Family | Usage |
|---|---|---|
| `font-sans` | Inter | Body text, labels, inputs, default |
| `font-space` | Space Grotesk | Logo mark (KAIZEN), brand headings |
| `font-manrope` | Manrope | Hero text on welcome screen |

### Custom CSS

```css
/* Custom thin scrollbar — applied globally */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #332640; border-radius: 10px; }

/* Step textarea line-rule background */
.code-input {
  background-image: repeating-linear-gradient(
    transparent, transparent 23px, rgba(255,255,255,0.03) 24px
  );
  line-height: 24px;
}
```

---

## 4. Atomic Design Hierarchy

### Rule
- **Atoms** have zero dependencies on other components in this codebase.
- **Molecules** import only atoms.
- **Organisms** import atoms and molecules. They may hold local UI state (e.g. step list, dropdown open/closed).
- **Pages** import organisms and molecules. They hold no styling logic — layout only.

---

### 4.1 Atoms

#### `Logo`
The KAIZEN logotype. "KAI" in white, "ZEN" in `brand-orange`. Font: Space Grotesk bold.

```tsx
type LogoProps = { size?: 'sm' | 'md' | 'lg'; className?: string }
```

---

#### `Button`

```tsx
type ButtonProps = {
  variant: 'primary-orange' | 'primary-pink' | 'outline-orange' | 'ghost-pink' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
}
```

| Variant | Appearance |
|---|---|
| `primary-orange` | Gradient `brand-orange-light → brand-orange`, black text, arrow-right icon |
| `primary-pink` | Gradient `brand-pink-light → brand-pink-mid`, black text |
| `outline-orange` | Transparent bg, `brand-orange` border + text, hover: subtle orange bg |
| `ghost-pink` | `card-bg` bg, `brand-pink` text, subtle border |
| `destructive` | Transparent, `brand-red` text, hover: red tint bg |

---

#### `Input`

```tsx
type InputProps = {
  type?: 'text' | 'email' | 'password';
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  rightElement?: React.ReactNode; // icon or text suffix (e.g. "@" symbol, lock icon)
  focusVariant?: 'orange' | 'pink' | 'accent'; // border color on focus
  className?: string;
}
```

---

#### `Textarea`

```tsx
type TextareaProps = {
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  codeStyle?: boolean; // applies .code-input line-rule background
  className?: string;
}
```

---

#### `Label`

```tsx
type LabelProps = {
  children: React.ReactNode;
  rightSlot?: React.ReactNode; // optional right-aligned content (e.g. ID badge)
  htmlFor?: string;
}
```
Appearance: 11px, font-semibold, gray-400, tracking-wider, uppercase.

---

#### `Badge`

```tsx
type BadgeProps = {
  icon?: React.ReactNode;
  children: React.ReactNode;
  variant?: 'pink' | 'orange';
}
```
Pill shape, bordered, blurred background. Used for "Neural Architecture V2.4" on welcome screen.

---

#### `Divider`

```tsx
type DividerProps = { label: string }
```
Horizontal line pair with centered label text. Used for "Or Login with" / "Or Sign Up with".

---

### 4.2 Molecules

#### `FormField`
Label + Input composed together.

```tsx
type FormFieldProps = {
  label: string;
  labelRightSlot?: React.ReactNode;
  inputProps: InputProps;
}
```

---

#### `NavBar`
Top navigation bar shared across login, signup, and new-test pages.

```tsx
type NavLink = { label: string; href: string; active?: boolean };

type NavBarProps = {
  links?: NavLink[];
  rightSlot?: React.ReactNode; // icons (bell, settings) or profile avatar
  sticky?: boolean;
  bordered?: boolean;
}
```

---

#### `SocialAuthRow`
Side-by-side Google + Facebook buttons.

```tsx
type SocialAuthRowProps = {
  label: string; // "Or Login with" / "Or Sign Up with"
  onGoogle?: () => void;
  onFacebook?: () => void;
}
```

---

#### `StepItem`
Single numbered step row in the execution steps list.

```tsx
type StepItemProps = {
  index: number;             // 1-based; displayed as "01", "02"...
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
  placeholder?: string;
}
```

---

#### `ProfileDropdown`
Avatar button that toggles a small dropdown with Settings + Logout.

```tsx
type ProfileDropdownProps = {
  onSettings?: () => void;
  onLogout?: () => void;
}
```

---

#### `SuiteSelector`
A single select row showing an icon, label, and chevron. Visual only at this stage.

```tsx
type SuiteSelectorProps = {
  value: string;
  onChange?: (value: string) => void;
}
```

---

### 4.3 Organisms

#### `AuthCard`
Centered card wrapper for login and signup forms. Contains the top highlight line and card shadow.

```tsx
type AuthCardProps = {
  title: string;
  children: React.ReactNode;
}
```

---

#### `LoginForm`
Full login form inside an AuthCard. Contains email field, password field, login button, forgot password, social auth row, and signup link.

```tsx
type LoginFormProps = {
  onSubmit?: (data: { email: string; password: string }) => void;
  onForgotPassword?: () => void;
  onSignUp?: () => void;
  onGoogle?: () => void;
  onFacebook?: () => void;
}
```

---

#### `SignupForm`
Full signup form inside an AuthCard. Contains email, password, confirm password, signup button, social auth row, and login link.

```tsx
type SignupFormProps = {
  onSubmit?: (data: { email: string; password: string; confirmPassword: string }) => void;
  onLogin?: () => void;
  onGoogle?: () => void;
  onFacebook?: () => void;
}
```

---

#### `WelcomeHero`
The landing screen content: background glow layers, badge, hero heading, subtitle, Login + Sign Up buttons.

```tsx
type WelcomeHeroProps = {
  onLogin?: () => void;
  onSignUp?: () => void;
}
```

---

#### `NewTestPanel`
The full new-test form: test name/description panel, execution steps panel, expected results panel, suite selector, and Run Test button. Holds all local UI state (step list, step values).

```tsx
type NewTestPanelProps = {
  initialSteps?: string[];
  onRun?: (data: NewTestData) => void;
  onSave?: (data: NewTestData) => void;
  onBack?: () => void;
  testId?: string; // e.g. "#1001"
}

type NewTestData = {
  name: string;
  description: string;
  steps: string[];
  expectedResults: string;
  suite: string;
}
```

---

## 5. Pages

### `/` — Welcome
- Background: `welcome-bg`
- Organisms: `WelcomeHero`
- Nav: minimal (logo + nav links, no right icons)

### `/login` — Login
- Background: `app-bg`
- Organisms: `LoginForm` (inside `AuthCard`)
- Nav: `NavBar` with bell + settings icons

### `/signup` — Sign Up
- Background: `app-bg`
- Organisms: `SignupForm` (inside `AuthCard`)
- Nav: `NavBar` with bell + settings icons

### `/tests/new` — New Test
- Background: `app-bg`
- Organisms: `NewTestPanel`
- Nav: `NavBar` sticky, with "Back to Suite" button + `ProfileDropdown`

---

## 6. Component Contracts

### Strict rules
1. **No hardcoded colors.** Every color class references a Tailwind token from `tailwind.config.ts`.
2. **No inline styles** except the `code-input` CSS class defined in globals.
3. **All interactive state** (open/closed dropdown, step list mutations, input values) lives in organisms or pages — never in atoms.
4. **Atoms are stateless.** They receive value and onChange as props.
5. **No `fetch` calls** in any component in this spec version. All data is via props.
6. **`'use client'`** only on organisms and molecules that use `useState`/`useEffect`. Atoms are always server-compatible.

### Naming
- Files: `kebab-case.tsx` (e.g. `form-field.tsx`)
- Exports: PascalCase named export (e.g. `export function FormField(...)`)
- One component per file
- No default exports

---

## 7. Routing

All navigation between pages is via Next.js `<Link>` in organisms/pages. No router.push in atoms or molecules. Route map:

| Route | Component |
|---|---|
| `/` | WelcomePage |
| `/login` | LoginPage |
| `/signup` | SignupPage |
| `/tests/new` | NewTestPage |

---

## 8. Conventions

- `cn()` utility function (clsx + tailwind-merge) for conditional class merging — defined once in `src/lib/cn.ts`
- Google/Facebook SVG icons defined once in `src/components/atoms/social-icons.tsx`
- lucide-react icons imported per-component, never as a barrel
- All form elements use controlled pattern (`value` + `onChange`) — no uncontrolled refs
