# Imports NautilusTrader from the venv the base layer installs, and prints its
# version. A file in the run's cwd: under the read fence the CLI cannot trace
# inline code (`python -c`), and dontAsk denies it whatever the allow rules.
import nautilus_trader

print(nautilus_trader.__version__)
