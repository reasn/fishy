

brew install java

Download https://github.com/AsamK/signal-cli and copy it into this folder

Link
```sh
./signal-cli-0.13.6/bin/signal-cli link -n fishy
```

Test
```sh
./signal-cli-0.13.6/bin/signal-cli send +491742035601 --note-to-self -m "Hallo \
new line \


yehaa🪸\
"

```


## Future ideas
Recipient-specific flow to account for later invitees

### Open challenges
* Late invitations shouldn't cycle through all steps
* Minimum time intervals between messages should be adhered to automatically