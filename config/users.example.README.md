# users.json

Copy `users.example.json` to `users.json` and replace each `REPLACE_WITH_BCRYPT_HASH`
with a real bcrypt hash. Generate one with:

```bash
node -e "console.log(require('bcryptjs').hashSync('PASSWORD',10))"
```
