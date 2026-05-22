# Fine-Tuning Dataset Tools

Two Python scripts for building fine-tuning datasets from oh-my-pi session files.

## Workflow

```bash
# 1. Rate your existing sessions
./scripts/rate-sessions.py

# 2. Convert rated turns to training formats
./scripts/convert-to-training-format.py

# 3. Train with your preferred library (Unsloth, TRL, etc.)
```

## 1. Rating Sessions (`rate-sessions.py`)

Batch-review existing session files and collect quality ratings.

### Basic Usage

```bash
# Rate all sessions
./scripts/rate-sessions.py

# Rate only recent sessions (last 7 days)
./scripts/rate-sessions.py --recent 7

# Rate a specific session
./scripts/rate-sessions.py --session ~/.omp/agent/sessions/path/to/session.jsonl

# Don't skip already-rated sessions (re-rate)
./scripts/rate-sessions.py --no-resume
```

### Interactive Rating

For each conversation turn, you'll see:
- 👤 User prompt
- 🧠 Thinking blocks (if present)
- 🤖 Assistant response
- 📊 Model metadata

Then rate it:
- `5` - Excellent
- `4` - Good
- `3` - Acceptable
- `2` - Poor
- `1` - Very Poor
- `s` - Skip (don't save)
- `q` - Quit

### Output

Rated turns are saved to `~/.omp/fine-tune-data/rated-turns.jsonl`:

```jsonl
{
  "prompt": "user message...",
  "thinking": "assistant thinking..." | null,
  "response": "assistant response...",
  "rating": 5,
  "model": "gemma4-26b-q6-100k",
  "provider": "llama-server-lyserg",
  "session_id": "019e44d8-cc86-7000-a54c-67ec992859a4",
  "timestamp": "2026-05-20T10:07:35.190Z"
}
```

## 2. Converting to Training Formats (`convert-to-training-format.py`)

Converts rated turns to SFT and DPO formats.

### Usage

```bash
./scripts/convert-to-training-format.py
```

### Output Files

**SFT Dataset** (`sft-dataset.jsonl`) - For supervised fine-tuning:
- Includes only turns with rating ≥ 4
- Standard chat format for training

```jsonl
{
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "<thinking>...</thinking>\n..."}
  ],
  "rating": 5,
  "model": "...",
  "provider": "..."
}
```

**DPO Dataset** (`dpo-dataset.jsonl`) - For preference optimization:
- Pairs responses to the same prompt with different ratings
- Higher-rated = "chosen", lower-rated = "rejected"

```jsonl
{
  "prompt": "user message...",
  "chosen": "better response...",
  "rejected": "worse response...",
  "chosen_rating": 5,
  "rejected_rating": 2
}
```

## 3. Training Examples

### Unsloth (SFT)

```python
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer

# Load model
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Llama-3.2-3B-Instruct",
    max_seq_length=2048,
    load_in_4bit=True,
)

# Load dataset
dataset = load_dataset("json", data_files="~/.omp/fine-tune-data/sft-dataset.jsonl")

# Train
trainer = SFTTrainer(
    model=model,
    train_dataset=dataset["train"],
    dataset_text_field="messages",
    max_seq_length=2048,
)

trainer.train()
```

### Unsloth (DPO)

```python
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import DPOTrainer

# Load model (must be SFT'd first)
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="path/to/sft-model",
    max_seq_length=2048,
    load_in_4bit=True,
)

# Load DPO dataset
dataset = load_dataset("json", data_files="~/.omp/fine-tune-data/dpo-dataset.jsonl")

# Train with DPO
trainer = DPOTrainer(
    model=model,
    train_dataset=dataset["train"],
    tokenizer=tokenizer,
)

trainer.train()
```

### TRL (Full RLHF with PPO)

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import PPOTrainer, PPOConfig, RewardTrainer

# 1. Train reward model from ratings
reward_trainer = RewardTrainer(
    model=reward_model,
    train_dataset=rated_turns_dataset,
)

# 2. Use PPO to optimize against reward
config = PPOConfig(learning_rate=1e-5)
ppo_trainer = PPOTrainer(
    config=config,
    model=model,
    tokenizer=tokenizer,
    reward_model=reward_model,
)
```

## Tips

### Rating Strategy

1. **Filter first**: Only rate sessions where you did meaningful work
2. **Batch similar sessions**: Rate coding sessions together, then docs, etc.
3. **Use recent filter**: Start with `--recent 7` to avoid old/irrelevant sessions
4. **Be consistent**: Develop a mental rubric for each rating level

### Rating Guidelines

- **5 (Excellent)**: Perfect response, exactly what you wanted
- **4 (Good)**: Helpful, minor improvements possible
- **3 (Acceptable)**: Correct but verbose/awkward
- **2 (Poor)**: Partially correct, needed significant fixes
- **1 (Very Poor)**: Wrong, unhelpful, or misleading

### Quality Over Quantity

- 100 excellent examples > 1000 mediocre ones
- For DPO, you need clear preference gaps (5 vs 2, not 4 vs 3)
- Filter out debugging sessions, failed attempts, and exploratory work

## Advanced Usage

### Custom Output Location

```bash
./scripts/rate-sessions.py --output /path/to/my-ratings.jsonl
```

### Process Multiple Projects

```bash
# Rate project A sessions
./scripts/rate-sessions.py --session-dir ~/.omp/agent/sessions/ProjectA

# Rate project B sessions
./scripts/rate-sessions.py --session-dir ~/.omp/agent/sessions/ProjectB
```

### Thinking Content

The scripts automatically include thinking blocks from models that support them (Claude 3.5+, DeepSeek R1, QwQ). Thinking is wrapped in `<thinking>...</thinking>` tags in the final training data, which helps models learn reasoning patterns.

## Troubleshooting

**No sessions found:**
- Check session directory: `ls ~/.omp/agent/sessions/`
- Sessions are in subdirectories named by workspace path

**Already-rated sessions skipped:**
- Use `--no-resume` to re-rate
- Or delete output file to start fresh

**Empty turns:**
- Extension-only sessions (no user/assistant turns) are skipped
- Tool-only exchanges are filtered out

**Conversion produces no DPO pairs:**
- Need multiple responses to the same prompt with different ratings
- Re-run agent on same prompts or use `/retry` to generate alternatives
