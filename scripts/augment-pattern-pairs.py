#!/usr/bin/env python3
"""
Create synthetic DPO pairs by pattern replacement.

Takes rated conversations and creates preference pairs by replacing patterns
(e.g., ASCII arrows -> LaTeX arrows) to bias the model's style preferences.

Usage:
    python scripts/augment-pattern-pairs.py --input rated-turns.jsonl --pattern latex-arrows

Output:
    ~/.omp/fine-tune-data/augmented-dpo.jsonl
"""

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple


# Pattern replacement rules: (pattern_name, [(ascii, latex), ...])
PATTERN_REPLACEMENTS = {
    "latex-arrows": [
        (r"->", r"\\to"),
        (r"=>", r"\\Rightarrow"),
        (r"<-", r"\\leftarrow"),
        (r"<=", r"\\Leftarrow"),
    ],
}


def has_pattern(text: str, patterns: List[str]) -> bool:
    """Check if text contains any of the given regex patterns."""
    for pattern in patterns:
        if re.search(re.escape(pattern), text):
            return True
    return False


def replace_ascii_to_latex(text: str, replacements: List[Tuple[str, str]]) -> Tuple[str, int]:
    """Replace ASCII patterns with LaTeX equivalents. Returns (new_text, num_replacements)."""
    result = text
    total_replacements = 0
    
    for ascii_pattern, latex_pattern in replacements:
        # Escape the patterns for literal matching
        result, count = re.subn(re.escape(ascii_pattern), latex_pattern, result)
        total_replacements += count
    
    return result, total_replacements


def replace_latex_to_ascii(text: str, replacements: List[Tuple[str, str]]) -> Tuple[str, int]:
    """Replace LaTeX patterns with ASCII equivalents. Returns (new_text, num_replacements)."""
    result = text
    total_replacements = 0
    
    for ascii_pattern, latex_pattern in replacements:
        # Use raw pattern for LaTeX (already escaped in the definition)
        result, count = re.subn(latex_pattern, ascii_pattern, result)
        total_replacements += count
    
    return result, total_replacements


def replace_pattern_in_messages(
    messages: List[Dict[str, Any]],
    replacements: List[Tuple[str, str]],
    ascii_to_latex: bool
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Replace patterns in all assistant messages.
    
    Returns:
        (new_messages, total_replacements)
    """
    new_messages = []
    total_replacements = 0
    
    for msg in messages:
        new_msg = msg.copy()
        
        if msg["role"] == "assistant":
            content = msg["content"]
            
            if ascii_to_latex:
                new_content, count = replace_ascii_to_latex(content, replacements)
            else:
                new_content, count = replace_latex_to_ascii(content, replacements)
            
            new_msg["content"] = new_content
            total_replacements += count
        
        new_messages.append(new_msg)
    
    return new_messages, total_replacements


def augment_entry(
    entry: Dict[str, Any],
    pattern_name: str,
    replacements: List[Tuple[str, str]]
) -> List[Dict[str, Any]]:
    """
    Create DPO pairs from a single entry by pattern replacement.
    
    Returns:
        List of DPO entries (may be empty if no patterns found)
    """
    messages = entry["messages"]
    
    # Check which patterns exist in the messages
    all_ascii = [r[0] for r in replacements]
    all_latex = [r[1] for r in replacements]
    
    # Extract assistant content for pattern checking
    assistant_content = " ".join(
        msg["content"] for msg in messages if msg["role"] == "assistant"
    )
    
    has_ascii = has_pattern(assistant_content, all_ascii)
    has_latex = has_pattern(assistant_content, all_latex)
    
    dpo_entries = []
    
    # If has ASCII, create a pair: ASCII (chosen) vs LaTeX (rejected)
    if has_ascii:
        rejected_messages, num_replaced = replace_pattern_in_messages(
            messages, replacements, ascii_to_latex=True
        )
        
        if num_replaced > 0:
            # Extract context (all but last assistant response)
            context_messages = [m for m in messages if m["role"] != "assistant"]
            if messages[-1]["role"] == "assistant":
                # Add back assistant messages except the last one
                for msg in messages:
                    if msg["role"] == "assistant" and msg != messages[-1]:
                        context_messages.append(msg)
            
            # Find last assistant message in original and rejected
            chosen_response = next(
                msg["content"] for msg in reversed(messages)
                if msg["role"] == "assistant"
            )
            rejected_response = next(
                msg["content"] for msg in reversed(rejected_messages)
                if msg["role"] == "assistant"
            )
            
            dpo_entries.append({
                "messages": context_messages if context_messages else [],
                "chosen": chosen_response,
                "rejected": rejected_response,
                "pattern": pattern_name,
                "direction": "ascii_preferred",
                "num_replacements": num_replaced,
                "rating": entry.get("rating"),
                "model": entry.get("model"),
                "provider": entry.get("provider"),
            })
    
    # If has LaTeX, create a pair: ASCII (chosen) vs LaTeX (rejected)
    if has_latex:
        preferred_messages, num_replaced = replace_pattern_in_messages(
            messages, replacements, ascii_to_latex=False
        )
        
        if num_replaced > 0:
            # Extract context
            context_messages = [m for m in messages if m["role"] != "assistant"]
            if messages[-1]["role"] == "assistant":
                for msg in messages:
                    if msg["role"] == "assistant" and msg != messages[-1]:
                        context_messages.append(msg)
            
            # Find last assistant message
            chosen_response = next(
                msg["content"] for msg in reversed(preferred_messages)
                if msg["role"] == "assistant"
            )
            rejected_response = next(
                msg["content"] for msg in reversed(messages)
                if msg["role"] == "assistant"
            )
            
            dpo_entries.append({
                "messages": context_messages if context_messages else [],
                "chosen": chosen_response,
                "rejected": rejected_response,
                "pattern": pattern_name,
                "direction": "latex_to_ascii",
                "num_replacements": num_replaced,
                "rating": entry.get("rating"),
                "model": entry.get("model"),
                "provider": entry.get("provider"),
            })
    
    return dpo_entries


def main():
    parser = argparse.ArgumentParser(
        description="Create synthetic DPO pairs by pattern replacement"
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=Path.home() / ".omp/fine-tune-data/rated-turns.jsonl",
        help="Input file with rated turns (default: ~/.omp/fine-tune-data/rated-turns.jsonl)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.home() / ".omp/fine-tune-data/augmented-dpo.jsonl",
        help="Output file for DPO pairs (default: ~/.omp/fine-tune-data/augmented-dpo.jsonl)",
    )
    parser.add_argument(
        "--pattern",
        choices=list(PATTERN_REPLACEMENTS.keys()),
        default="latex-arrows",
        help="Pattern type to augment (default: latex-arrows)",
    )
    parser.add_argument(
        "--min-rating",
        type=int,
        default=4,
        help="Minimum rating to include (default: 4)",
    )
    
    args = parser.parse_args()
    
    replacements = PATTERN_REPLACEMENTS[args.pattern]
    
    print(f"🔄 Augmenting data with pattern: {args.pattern}")
    print(f"   ASCII ↔ LaTeX replacements: {len(replacements)}")
    print(f"   Min rating: {args.min_rating}")
    
    # Ensure output directory exists
    args.output.parent.mkdir(parents=True, exist_ok=True)
    
    # Clear output file
    if args.output.exists():
        args.output.unlink()
    
    # Load input data
    if not args.input.exists():
        print(f"❌ Input file not found: {args.input}")
        return
    
    entries = []
    with open(args.input) as f:
        for line in f:
            entries.append(json.loads(line))
    
    print(f"\n📂 Loaded {len(entries)} entries from {args.input.name}")
    
    # Process entries
    total_pairs = 0
    entries_with_patterns = 0
    
    for entry in entries:
        # Filter by rating
        if entry.get("rating", 0) < args.min_rating:
            continue
        
        dpo_entries = augment_entry(entry, args.pattern, replacements)
        
        if dpo_entries:
            entries_with_patterns += 1
            
            for dpo_entry in dpo_entries:
                with open(args.output, "a") as f:
                    f.write(json.dumps(dpo_entry) + "\n")
                total_pairs += 1
    
    # Summary
    print(f"\n{'='*70}")
    print(f"✅ Created {total_pairs} DPO pairs")
    print(f"   From {entries_with_patterns}/{len(entries)} entries with patterns")
    print(f"📁 Saved to: {args.output}")
    print(f"{'='*70}")
    
    if total_pairs > 0:
        print("\nNext steps:")
        print("  1. Review pairs: cat ~/.omp/fine-tune-data/augmented-dpo.jsonl | jq | less")
        print("  2. Train with DPO (Unsloth, TRL, etc.)")
        print("\nExample Unsloth DPO:")
        print("  from trl import DPOTrainer")
        print("  trainer = DPOTrainer(model=model, train_dataset=dataset, ...)")
    else:
        print(f"\n⚠️  No entries found with {args.pattern} patterns")
        print("   Check your data contains ASCII (-> =>) or LaTeX (\\to \\Rightarrow) arrows")


if __name__ == "__main__":
    main()
