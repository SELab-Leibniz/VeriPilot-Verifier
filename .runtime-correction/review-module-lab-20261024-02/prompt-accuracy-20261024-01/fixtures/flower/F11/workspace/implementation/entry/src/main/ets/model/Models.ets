export class Commodity {
  id: number
  name: string
  flowerLanguage: string
  spec: string
  price: number
  imageUrl: string

  constructor(id: number, name: string, flowerLanguage: string, spec: string, price: number, imageUrl: string) {
    this.id = id;
    this.name = name;
    this.flowerLanguage = flowerLanguage;
    this.spec = spec;
    this.price = price;
    this.imageUrl = imageUrl;
  }
}

export class Store {
  id: number
  name: string
  address: string
  phone: string
  lat: number
  lng: number

  constructor(id: number, name: string, address: string, phone: string, lat: number, lng: number) {
    this.id = id;
    this.name = name;
    this.address = address;
    this.phone = phone;
    this.lat = lat;
    this.lng = lng;
  }
}
