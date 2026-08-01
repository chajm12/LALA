import os

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def main() -> None:
    message = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Hello, Claude"}],
    )
    print(message.content[0].text)


if __name__ == "__main__":
    main()
