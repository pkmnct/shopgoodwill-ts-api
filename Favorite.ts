export interface ShopgoodwillFavoriteApiResult {
  message: string;
  status: boolean;
  type: null;
  primaryKey: null;
  isUnauthorized: boolean;
  data: ShopgoodwillFavorite[];
}

export interface ShopgoodwillFavorite {
  imageStatus: number;
  itemId: number;
  numBids: number;
  quantityWon: number;
  watchlistId: number;
  type: ShopgoodwillFavoriteType;
  discountedBuyNowPrice: number;
  discount: number;
  buyNowPrice: number;
  currentPrice: number;
  minimumBid: number;
  maxBid: null;
  isStock: boolean;
  imageServer: string;
  imageURL: string;
  notes: string;
  sellerName: string;
  title: string;
  endTime: Date;
  startTime: Date;
  catFullName: string;
  sellerId: number;
  itemPartNumber: null | string;
  itemQuantity: number;
  listingType: number;
}

export enum ShopgoodwillFavoriteType {
  Close = "Close",
  Open = "Open",
}
