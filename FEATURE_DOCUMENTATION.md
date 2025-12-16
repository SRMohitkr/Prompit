# Usage Counter Feature Documentation

## Overview
This document outlines the implementation of the **Usage Counter** feature for Prompit — a Tier-1 retention feature designed to build subconscious trust through subtle feedback loops.

---

## Feature Behavior

### 1. Copy Action
- User clicks the copy icon on a prompt card
- Prompt text is copied to clipboard **instantly**
- Copy button shows a checkmark (✓) for 1.5 seconds visual feedback
- Reverts back to copy icon automatically
- Usage count increments by 1
- Toast notification: "Copied to clipboard!"

### 2. Usage Display
- Below the tags, displays: `"Used X times"` or `"Used X time"` (singular/plural)
- Subtle styling: small, secondary color, 0.7 opacity
- Only displays if usage > 0 (no clutter for new prompts)
- Right-aligned in the card footer for visual hierarchy

### 3. Safeguard
- If a user copies the same prompt twice within 2 seconds, usage only increments once
- Prevents accidental double-counting on network hiccups
- Maintains clean, honest usage metrics

---

## Data Structure

### Local Storage
Each prompt now includes:
```javascript
{
  id: "uuid",
  title: "...",
  body: "...",
  tags: [],
  category: "...",
  favorite: boolean,
  total_usage: number,        // NEW: Usage count
  last_used_at: "ISO-8601",   // NEW: Last copy timestamp
  date: "ISO-8601",
  cloud_id: "uuid (optional)"
}
```

### Database Schema (Supabase)
Added to `prompt_saves` table:
```sql
total_usage integer default 0,
last_used_at timestamp with time zone
```

Idempotent migration handles existing tables gracefully.

---

## Implementation Details

### JavaScript Changes

#### 1. Global Copy Tracking
```javascript
const recentCopies = new Map();  // Prevents double-counting within 2 seconds
```

#### 2. Enhanced copyPrompt() Function
- Copies to clipboard instantly
- Provides button feedback (checkmark icon, 1.5 seconds)
- Increments usage count with safeguard
- Syncs usage to cloud database
- Re-renders prompts to show updated count

#### 3. New syncUsageToCloud() Function
- Updates `total_usage` and `last_used_at` in Supabase
- Respects RLS policies (user_id or device_id)
- Gracefully queues offline updates if sync fails

#### 4. Updated renderPrompts() Function
- Calculates usage count from prompt data
- Generates grammatically correct text ("1 time" vs "2+ times")
- Inserts usage text in card footer only when > 0

### CSS Changes

#### 1. Usage Text Styling (.usage-text)
```css
font-size: 0.75rem;           /* Subtle size */
color: var(--text-secondary); /* Secondary text color */
opacity: 0.7;                 /* Understated */
font-weight: 500;
white-space: nowrap;          /* Prevents wrapping */
margin-left: auto;            /* Right alignment */
```

#### 2. Copy Button Feedback (.icon-btn.copied-state)
```css
color: var(--success-color);  /* Green checkmark */
```

#### 3. Card Footer Enhancement
```css
flex-wrap: wrap;              /* Allows tags + usage on same line when space available */
gap: 12px;                    /* Proper spacing between elements */
```

---

## UX Principles Applied

✅ **Instant Feedback**: Copy happens immediately, no delay  
✅ **Calm Design**: No gamification, no badges, no leaderboards  
✅ **Subtle Signal**: Small text, secondary color, low opacity  
✅ **Trust Building**: Subconscious cue: "I've used this before, it must be good"  
✅ **Non-Intrusive**: No popups, modals, or excessive animation  
✅ **Honest Metrics**: Only increments on actual use, not on hover/view  
✅ **Performance**: Non-blocking UI, background cloud sync  

---

## User Flow (Step-by-Step)

1. User views prompt card with tags and other metadata
2. User clicks copy icon
3. **Instant**: Text copied to clipboard, button shows ✓
4. **Simultaneous**: Usage count increments, card re-renders
5. **Result**: User sees "Used X times" below tags
6. **Psychology**: On future visits, user unconsciously recognizes prompt value
7. **Outcome**: Higher reuse rate, less friction than rewriting

---

## Database Migration

Run in Supabase SQL Editor:

```sql
-- Add usage tracking columns if they don't exist (idempotent)
do $$
begin
  if not exists (select 1 from information_schema.columns 
                 where table_name = 'prompt_saves' and column_name = 'total_usage') then
     alter table public.prompt_saves add column total_usage integer default 0;
  end if;
  
  if not exists (select 1 from information_schema.columns 
                 where table_name = 'prompt_saves' and column_name = 'last_used_at') then
     alter table public.prompt_saves add column last_used_at timestamp with time zone;
  end if;
end $$;
```

---

## Code Comments

Key functions are annotated with comments explaining:
- Why safeguard exists (prevent double-counting)
- What happens when (button feedback timing)
- How data flows (local → cloud sync)

---

## Backward Compatibility

✅ Existing prompts load correctly with `total_usage = 0` (initialized dynamically)  
✅ No breaking changes to existing features  
✅ Null/undefined usage values handled gracefully  
✅ Cloud sync respects all existing RLS policies  
✅ Guest and authenticated users both supported  

---

## Performance Considerations

- **No blocking**: Usage updates don't freeze UI
- **Async sync**: Cloud updates happen in background
- **Efficient storage**: Only two additional integers per prompt
- **Re-render**: Only re-renders (doesn't re-fetch) on copy
- **Memory**: recentCopies map cleaned up naturally (Map stores last ~100 items)

---

## Testing Checklist

- [x] Copy works offline
- [x] Usage increments only on actual copy
- [x] Double-copy within 2s prevented
- [x] Button shows ✓ for 1.5 seconds
- [x] Usage text displays "1 time" (singular)
- [x] Usage text displays "X times" (plural)
- [x] Cloud sync updates total_usage and last_used_at
- [x] New prompts default to 0 usage
- [x] UI looks clean, no visual clutter
- [x] Works in both light and dark mode
- [x] Mobile responsive
- [x] RLS policies respected

---

## Future Enhancements (Not Included)

- Sort prompts by usage (would break trust principle)
- Usage analytics dashboard (would gamify)
- Achievement notifications (against brief)
- Trending prompts feature (creates competition)
- Sharing usage with others (privacy concern)

---

## Files Modified

1. `/home/mohit/code/prompit/app.js`
   - Database schema with new columns
   - Enhanced copyPrompt() function
   - New syncUsageToCloud() function
   - Updated renderPrompts() to display usage
   - Global recentCopies tracking

2. `/home/mohit/code/prompit/style.css`
   - .usage-text styling
   - .icon-btn.copied-state styling
   - .card-footer layout enhancement

---

## Summary

This implementation adds a **subtle, non-intrusive usage counter** that builds subconscious trust without gamification. The feature respects the core principles of quiet confidence and honest feedback, designed to increase reuse through recognition rather than competition.

**Impact**: Users will instinctively reach for prompts they've used before, reducing cognitive load and increasing product stickiness.
