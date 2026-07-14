# Visual QA (stage 2)

**Assume there are problems.** First render is rarely perfect.

## Machine checks (always-on via validate_deck)

- Bullet count / word limits  
- Slide count cap  
- Required fields per `type`  
- Filler-phrase warnings  
- Em dash stripping  

## Optional visual pass

If the user asks for a polish pass or something looks off:

1. Open PRESENT_URL and click through every slide  
2. Check: overflow, cramped columns, empty content slides, low contrast  
3. Fix **deck-spec content only**, re-run `render_deck.py`  
4. One fix-and-verify cycle minimum before declaring done  

### Image QA (when LibreOffice/Chromium available)

```bash
# HTML → screenshots via browser, or Marp PDF → images
pdftoppm -jpeg -r 150 deck.pdf slide
```

Critic prompt (fresh context): list defects only — overlapping text, cut-off edges, sparse vs cramped, leftover "lorem/xxxx".

## Do not

- Infinite retry loops (cap 3 per stage)  
- "Looks good" without scanning each slide once  
