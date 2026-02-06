## Voice assets (generated)

- `high-wattage-ja.wav`
  - Generated with macOS `say` (voice: Kyoko)
  - Text: 消費電力が高くなっています。不要な家電の運転を停止してください。

Re-generate:

```bash
say -v Kyoko -o high-wattage-ja.aiff "消費電力が高くなっています。不要な家電の運転を停止してください。"
afconvert high-wattage-ja.aiff high-wattage-ja.wav -f WAVE -d LEI16
rm high-wattage-ja.aiff
```
