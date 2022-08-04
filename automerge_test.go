package automerge_test

import (
	"fmt"
	"testing"

	automerge "github.com/progrium/goja-automerge"
)

func ExampleQuickstart() {
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
}

func TestObject(t *testing.T) {
	v := automerge.DefaultRuntime.CreateObject(nil)
	v.Set("bool", true)
	v.Set("str", "foo")
	o := automerge.ToObject(v)
	if o.Get("bool").Export() != true {
		t.Fatal("bool value not what was expected")
	}
	if got := o.Get("str").Export(); got != "foo" {
		t.Fatal("str value not what was expected:", got)
	}
}
