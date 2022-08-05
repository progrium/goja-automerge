package automerge

import (
	"fmt"

	"github.com/dop251/goja"
	"github.com/dop251/goja_nodejs/console"
	"github.com/dop251/goja_nodejs/require"

	_ "embed"
)

//go:embed automerge.es5.js
var jsSrc string

var DefaultRuntime *goja.Runtime

func init() {
	DefaultRuntime = goja.New()
	new(require.Registry).Enable(DefaultRuntime)
	console.Enable(DefaultRuntime)

	src := goja.MustCompile("automerge.es5.js", jsSrc, true)
	if _, err := DefaultRuntime.RunString("window = {}"); err != nil {
		panic(err)
	}
	if _, err := DefaultRuntime.RunProgram(src); err != nil {
		panic(err)
	}
	if _, err := DefaultRuntime.RunString("Automerge = window.Automerge"); err != nil {
		panic(err)
	}

}

func Init() *Object {
	v, err := DefaultRuntime.RunString("Automerge.init()")
	if err != nil {
		panic(err)
	}
	return ToObject(v)
}

func Change(doc *Object, message string, changeFn func(*Object)) *Object {
	change, ok := goja.AssertFunction(DefaultRuntime.Get("Automerge").ToObject(DefaultRuntime).Get("change"))
	if !ok {
		panic("Automerge.change not a function in runtime")
	}
	v, err := change(goja.Undefined(), doc.Object, DefaultRuntime.ToValue(message), DefaultRuntime.ToValue(func(doc *goja.Object) {
		changeFn(ToObject(doc))
	}))
	if err != nil {
		panic(err)
	}
	return ToObject(v)
}

func Save(doc *Object) []byte {
	save, ok := goja.AssertFunction(DefaultRuntime.Get("Automerge").ToObject(DefaultRuntime).Get("save"))
	if !ok {
		panic("Automerge.save not a function in runtime")
	}
	v, err := save(goja.Undefined(), doc.Object)
	if err != nil {
		panic(err)
	}
	uintarr := v.ToObject(DefaultRuntime)
	length := uintarr.Get("byteLength").ToInteger()
	offset := uintarr.Get("byteOffset").ToInteger()
	buffer := uintarr.Get("buffer").Export().(goja.ArrayBuffer)
	return buffer.Bytes()[offset : length+offset]
}

type bytesArray struct {
	data []byte
}

func (arr bytesArray) Len() int {
	return len(arr.data)
}

func (arr bytesArray) Get(idx int) goja.Value {
	return DefaultRuntime.ToValue(arr.data[idx])
}

func (arr bytesArray) Set(idx int, val goja.Value) bool {
	return false // no-op
}

func (arr bytesArray) SetLen(s int) bool {
	return false // no-op
}

func Load(data []byte) *Object {
	uintarr, err := DefaultRuntime.New(DefaultRuntime.Get("Uint8Array"), DefaultRuntime.ToValue(data))
	if err != nil {
		panic(err)
	}
	load, ok := goja.AssertFunction(DefaultRuntime.Get("Automerge").ToObject(DefaultRuntime).Get("load"))
	if !ok {
		panic("Automerge.load not a function in runtime")
	}
	v, err := load(goja.Undefined(), uintarr)
	if err != nil {
		panic(err)
	}
	return ToObject(v)
}

func Merge(doc1 *Object, doc2 *Object) *Object {
	merge, ok := goja.AssertFunction(DefaultRuntime.Get("Automerge").ToObject(DefaultRuntime).Get("merge"))
	if !ok {
		panic("Automerge.merge not a function in runtime")
	}
	v, err := merge(goja.Undefined(), doc1.Object, doc2.Object)
	if err != nil {
		panic(err)
	}
	return ToObject(v)
}

func GetHistory(doc *Object) (h []map[string]map[string]interface{}) {
	history, ok := goja.AssertFunction(DefaultRuntime.Get("Automerge").ToObject(DefaultRuntime).Get("getHistory"))
	if !ok {
		panic("Automerge.getHistory not a function in runtime")
	}
	v, err := history(goja.Undefined(), doc.Object)
	if err != nil {
		panic(err)
	}
	if err := DefaultRuntime.ExportTo(v, &h); err != nil {
		panic(err)
	}
	return
}

type Object struct {
	*goja.Object
	val goja.Value
}

func ToObject(v goja.Value) *Object {
	if v == nil {
		return nil
	}
	return &Object{Object: v.ToObject(DefaultRuntime), val: v}
}

func (obj *Object) NewArray(items ...interface{}) *goja.Object {
	return DefaultRuntime.NewArray(items...)
}

func (obj *Object) NewObject() *goja.Object {
	return DefaultRuntime.NewObject()
}

func (obj *Object) Get(name string) *Object {
	return ToObject(obj.Object.Get(name))
}

func (obj *Object) Export() interface{} {
	if obj.val == nil {
		return nil
	}
	return obj.val.Export()
}

func (obj *Object) Call(name string, args ...interface{}) *Object {
	fn, ok := goja.AssertFunction(obj.Object.Get(name))
	if !ok {
		panic(fmt.Sprintf("%s not a function on object", name))
	}
	var argVals []goja.Value
	for _, arg := range args {
		argVals = append(argVals, DefaultRuntime.ToValue(arg))
	}
	v, err := fn(obj.Object, argVals...)
	if err != nil {
		panic(err.Error())
	}
	return ToObject(v)
}
