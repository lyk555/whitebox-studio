// The flat colours the model paints each thing in the room, in the order the stage lists them, so that a picture can
// say which thing is which. A plain cut-out only says what is a thing: when a table stands in front of a bookcase,
// nothing says where one stops and the other starts. Black is not one of them, since the model draws its lines in it.
export const OBJECT_COLOURS = [
  { name: '纯红色', hex: '#FF0000', rgb: [255, 0, 0] },
  { name: '纯蓝色', hex: '#0000FF', rgb: [0, 0, 255] },
  { name: '纯黄色', hex: '#FFFF00', rgb: [255, 255, 0] },
  { name: '品红色', hex: '#FF00FF', rgb: [255, 0, 255] },
  { name: '青色', hex: '#00FFFF', rgb: [0, 255, 255] },
  { name: '纯白色', hex: '#FFFFFF', rgb: [255, 255, 255] },
  { name: '橙色', hex: '#FF8000', rgb: [255, 128, 0] },
]
