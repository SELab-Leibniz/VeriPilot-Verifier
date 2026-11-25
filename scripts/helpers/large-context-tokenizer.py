"""Tokenize the exact captured OpenAI-compatible messages with public model assets."""
import hashlib
import json
from pathlib import Path
import sys

from jinja2 import Environment
from tokenizers import Tokenizer


MODELS = {
    "deepseek-v4-flash": (
        "DeepSeek-V4-Flash",
        "60d8d70770c6776ff598c94bb586a859a38244f1",
        "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf",
        "encoding_dsv4.py",
        "bdbd57c132a1b3725042323d02b98b9d1df28e5f388f134399555d041f5055e0",
    ),
    "deepseek-v4.1-flash": (
        "DeepSeek-V4.1-Flash",
        "314113f8a7dadb388215396ba5fbee2c610a04d6",
        "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
        "chat_template.jinja",
        "d959d804d5101b79a49b6ff1bf3c54cd5affa9a5a78c503d925f3090040b31c3",
    ),
}


def verified(asset, digest):
    value = asset.read_bytes()
    if hashlib.sha256(value).hexdigest() != digest:
        raise ValueError(f"Unexpected SHA-256 for {asset}")
    return value


def fail(message):
    raise ValueError(message)


def json_filter(value, **kwargs):
    return json.dumps(value, ensure_ascii=False, **kwargs)


def load_model(root, key):
    name, revision, tokenizer_hash, template_file, template_hash = MODELS[key]
    base = root / name
    tokenizer = Tokenizer.from_str(verified(base / "tokenizer.json", tokenizer_hash).decode())
    source = verified(base / template_file, template_hash).decode()
    if key == "deepseek-v4-flash":
        namespace = {}
        exec(compile(source, str(base / template_file), "exec"), namespace)
        encoder = namespace["encode_messages"]

        def render(messages, tools):
            for message in messages:
                content = message.get("content")
                if isinstance(content, list):
                    if any(block["type"] != "text" for block in content):
                        fail("Expected text-only OpenAI content")
                    message["content"] = "".join(block["text"] for block in content)
            if tools and messages[0]["role"] == "system":
                messages[0]["tools"] = tools
            elif tools:
                messages.insert(0, {"role": "system", "content": "", "tools": tools})
            return encoder(messages, thinking_mode="chat")
    else:
        env = Environment(trim_blocks=True, lstrip_blocks=True)
        env.globals["raise_exception"] = fail
        env.filters["tojson"] = json_filter
        env.filters["from_json"] = json.loads
        template = env.from_string(source)

        def render(messages, tools):
            return template.render(messages=messages, tools=tools, add_generation_prompt=True, thinking_mode="chat")
    return tokenizer, render, {"model": name, "revision": revision, "tokenizerSha256": tokenizer_hash, "templateSha256": template_hash}


def main():
    models = {key: load_model(Path(sys.argv[1]), key) for key in MODELS}
    print(json.dumps({key: model[2] for key, model in models.items()}), flush=True)
    for line in sys.stdin.buffer:
        try:
            payload = json.loads(line)
            tokenizer, render, _ = models[payload["model"]]
            prompt = render(payload["messages"], payload.get("tools"))
            encoding = tokenizer.encode(prompt, add_special_tokens=False)
            print(json.dumps({"tokens": len(encoding.ids), "renderedBytes": len(prompt.encode())}), flush=True)
        except (KeyError, TypeError, ValueError) as error:
            print(json.dumps({"error": str(error)}), flush=True)


if __name__ == "__main__":
    main()
