package objpath

import (
	"path"
	"reflect"
	"testing"

	"github.com/dop251/goja"
	automerge "github.com/progrium/goja-automerge"
)

func TestGet(t *testing.T) {
	vm := goja.New()
	vm.Set("obj", map[string]interface{}{
		"bool": true,
		"str":  "foo",
		"strs": []string{"a", "b", "c"},
		"obj": map[string]interface{}{
			"num":  2,
			"nums": []int{10, 20, 30},
			"sub": map[string]interface{}{
				"foo": "bar",
			},
		},
	})
	obj := automerge.ToObject(vm.Get("obj"))
	testdata := map[string]interface{}{
		"bool":        true,
		"/str":        "foo",
		"strs/1":      "b",
		"obj/num":     int64(2),
		"/obj/nums/0": int64(10),
		"obj/sub/foo": "bar",
	}
	for p, v := range testdata {
		got := Get(obj, p)
		if got != v {
			t.Fatalf("%s != %v (%v). got: %v (%v)", p, v, reflect.TypeOf(v), got, reflect.TypeOf(got))
		}
	}
}

func TestPut(t *testing.T) {
	vm := goja.New()
	vm.Set("obj", map[string]interface{}{
		"bool": true,
		"str":  "foo",
		"strs": []string{"a", "b", "c"},
		"obj": map[string]interface{}{
			"num":  2,
			"nums": []int{10, 20, 30},
			"sub": map[string]interface{}{
				"foo": "bar",
			},
		},
	})
	obj := automerge.ToObject(vm.Get("obj"))
	testdata := map[string]interface{}{
		"bool":        "notbool",
		"/str":        "bar",
		"strs/1":      "B",
		"obj/num":     int64(2000),
		"/obj/nums/0": int64(100),
		"obj/sub/foo": "baz",
	}
	for p, v := range testdata {
		err := Put(obj, p, v)
		if err != nil {
			t.Fatal(err)
		}
		got := Get(obj, p)
		if got != v {
			t.Fatalf("%s != %v (%v). got: %v (%v)", p, v, reflect.TypeOf(v), got, reflect.TypeOf(got))
		}
	}
}

func TestDelete(t *testing.T) {
	vm := goja.New()
	vm.Set("obj", map[string]interface{}{
		"bool": true,
		"str":  "foo",
		"strs": []string{"a", "b", "c"},
		"obj": map[string]interface{}{
			"num":  2,
			"nums": []int{10, 20, 30},
			"sub": map[string]interface{}{
				"foo": "bar",
			},
		},
	})
	obj := automerge.ToObject(vm.Get("obj"))
	testdata := []string{
		"bool",
		"/str",
		"obj/num",
		"obj/sub/foo",
	}
	for _, p := range testdata {
		err := Delete(obj, p)
		if err != nil {
			t.Fatal(err)
		}
		got := Get(obj, p)
		if got != nil {
			t.Fatalf("%s != nil. got: %v (%v)", p, got, reflect.TypeOf(got))
		}
	}
	testdata = []string{
		"strs/1",
		"/obj/nums/0",
	}
	for _, p := range testdata {
		before := Get(obj, path.Dir(p)+"/length").(int64)
		err := Delete(obj, p)
		if err != nil {
			t.Fatal(err)
		}
		after := Get(obj, path.Dir(p)+"/length").(int64)
		if after >= before {
			t.Fatalf("element not deleted")
		}
	}
}

func TestInsert(t *testing.T) {
	vm := goja.New()
	vm.Set("obj", map[string]interface{}{
		"strs": []string{"a", "b", "c"},
		"obj": map[string]interface{}{
			"nums": []int{10, 20, 30},
		},
	})
	obj := automerge.ToObject(vm.Get("obj"))
	if err := Insert(obj, "strs/", "PUSHED"); err != nil {
		t.Fatal(err)
	}
	if got := Get(obj, "strs/3"); got != "PUSHED" {
		t.Fatal("PUSHED not inserted")
	}
	if err := Insert(obj, "strs/1", "INSERTED"); err != nil {
		t.Fatal(err)
	}
	if got := Get(obj, "strs/1"); got != "INSERTED" {
		t.Fatal("INSERTED not inserted")
	}
	if err := Insert(obj, "/obj/nums/", 40); err != nil {
		t.Fatal(err)
	}
	if got := Get(obj, "/obj/nums/3"); got != int64(40) {
		t.Fatal("40 not inserted")
	}
	if err := Insert(obj, "/obj/nums/0", 1); err != nil {
		t.Fatal(err)
	}
	if got := Get(obj, "/obj/nums/0"); got != int64(1) {
		t.Fatal("1 not inserted")
	}
}
