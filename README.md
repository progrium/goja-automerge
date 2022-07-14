# goja-automerge
Automerge.js in Go via goja

This is mostly for prototyping (for what should be obvious reasons), but this package runs [automerge.js](https://github.com/automerge/automerge) in native Go (no CGO) via [goja](https://github.com/dop251/goja), wrapping the API so it feels more like a native Go library:

```golang
doc1 := automerge.Init()
doc1 = automerge.Change(doc1, "add cards", func(doc *automerge.Object) {
  doc.Set("cards", doc.NewArray())
  doc.Get("cards").Call("push", map[string]interface{}{
    "title": "Rewrite everything in Go",
    "done":  false,
  })
  doc.Get("cards").Call("push", map[string]interface{}{
    "title": "Rewrite everything in Zig",
    "done":  false,
  })
})

b := automerge.Save(doc1)
doc2 := automerge.Load(b)

doc1 = automerge.Change(doc1, "mark card as done", func(doc *automerge.Object) {
  doc.Get("cards").Get("0").Set("done", true)
})
doc2 = automerge.Change(doc2, "delete card", func(doc *automerge.Object) {
  doc.Get("cards").Delete("1")
})

finalDoc := automerge.Merge(doc1, doc2)
d, _ := finalDoc.MarshalJSON()
fmt.Println(string(d))
// Output: {"cards":[{"done":true,"title":"Rewrite everything in Go"}]}
```

A more production usable version of this would probably use [automerge-rs](https://github.com/automerge/automerge-rs) via WASM (again, to avoid CGO), but somebody else can put that together. Please.

The `automerge.es5.js` file is embedded in the package to be run in goja. This file was produced by taking `automerge.min.js@1.0.1-preview.7`, adding a polyfill for TextEncoder/TextDecoder, and running through Babel to get an ES5 version that can run in current version of goja.

## License

MIT